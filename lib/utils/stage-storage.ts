/**
 * Stage Storage Manager
 *
 * Manages multiple stage data in IndexedDB
 * Each stage has its own storage key based on stageId
 */

import { nanoid } from 'nanoid';
import { Stage, Scene } from '../types/stage';
import type { SceneOutline } from '../types/generation';
import { ChatSession } from '../types/chat';
import { db } from './database';
import { saveChatSessions, loadChatSessions, deleteChatSessions } from './chat-storage';
import { clearPlaybackState } from './playback-storage';
import { clearAllForScene } from '@/lib/quiz/persistence';
import { createLogger } from '@/lib/logger';

const log = createLogger('StageStorage');

export interface StageStoreData {
  stage: Stage;
  /** null means a new record; zero is an existing legacy record. */
  contentRevision?: number | null;
  scenes: Scene[];
  currentSceneId: string | null;
  chats: ChatSession[];
  outlines?: SceneOutline[];
  snapshotCursor?: number;
  snapshotSessionId?: string;
}

/** Runs inside the same transaction as the classroom payload. False cancels a stale request. */
export type StageHistoryWrite = (
  data: StageStoreData,
) => Promise<boolean | { metadataOnly: true; unchanged?: boolean } | void>;

export interface StageListItem {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  interactiveMode?: boolean;
}

export class StageSaveConflictError extends Error {
  constructor(
    readonly stageId: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(`Classroom save conflict: ${stageId}`);
    this.name = 'StageSaveConflictError';
  }
}

function storedRevision(record: { contentRevision?: number } | undefined): number | null {
  if (!record) return null;
  const revision = record.contentRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('Invalid classroom revision');
  return revision;
}

/**
 * Save stage data to IndexedDB
 */
export async function saveStageData(
  stageId: string,
  data: StageStoreData,
  writeHistory?: StageHistoryWrite,
): Promise<{ contentRevision: number | null; saved: boolean }> {
  try {
    const now = Date.now();
    let saved = false;
    let revision = data.contentRevision ?? null;

    // One transaction so a quota failure cannot delete scenes and then abort.
    // saveChatSessions opens a nested transaction on chatSessions only; Dexie
    // joins it to this one and rolls the classroom back together.
    await db.transaction(
      'rw',
      [
        db.stages,
        db.scenes,
        db.chatSessions,
        db.stageOutlines,
        ...(writeHistory ? [db.snapshots] : []),
      ],
      async () => {
        const previous = await db.stages.get(stageId);
        const actualRevision = storedRevision(previous);
        if (actualRevision !== revision) {
          throw new StageSaveConflictError(stageId, revision, actualRevision);
        }
        const historyResult = await writeHistory?.(data);
        if (historyResult === false) return;
        revision = (actualRevision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('Classroom revision limit reached');
        if (previous && typeof historyResult === 'object' && historyResult.metadataOnly) {
          if (
            historyResult.unchanged &&
            previous.snapshotCursor === data.snapshotCursor &&
            previous.snapshotSessionId === data.snapshotSessionId
          ) {
            revision = actualRevision;
            saved = true;
            return;
          }
          await db.stages.update(stageId, {
            contentRevision: revision,
            snapshotCursor: data.snapshotCursor,
            snapshotSessionId: data.snapshotSessionId,
          });
          saved = true;
          return;
        }
        await db.stages.put({
          id: stageId,
          contentRevision: revision,
          name: data.stage.name || 'Untitled Stage',
          description: data.stage.description,
          createdAt: data.stage.createdAt || now,
          updatedAt: now,
          languageDirective: data.stage.languageDirective,
          style: data.stage.style,
          currentSceneId: data.currentSceneId || undefined,
          agentIds: data.stage.agentIds,
          videoManifest: data.stage.videoManifest,
          interactiveMode: data.stage.interactiveMode,
          snapshotCursor: data.snapshotCursor ?? previous?.snapshotCursor,
          snapshotSessionId: data.snapshotSessionId ?? previous?.snapshotSessionId,
        });

        await db.scenes.where('stageId').equals(stageId).delete();

        if (data.scenes && data.scenes.length > 0) {
          await db.scenes.bulkPut(
            data.scenes.map((scene, index) => ({
              ...scene,
              stageId,
              order: scene.order ?? index,
              createdAt: scene.createdAt || now,
              updatedAt: scene.updatedAt || now,
            })),
          );
        }

        if (data.outlines) {
          await db.stageOutlines.put({
            stageId,
            outlines: data.outlines,
            createdAt: data.stage.createdAt || now,
            updatedAt: now,
          });
        }

        if (data.chats) {
          await saveChatSessions(stageId, data.chats);
        }
        saved = true;
      },
    );

    if (saved) log.info(`Saved stage: ${stageId}`);
    return { contentRevision: revision, saved };
  } catch (error) {
    log.error('Failed to save stage:', error);
    throw error;
  }
}

/**
 * Load stage data from IndexedDB
 */
export async function loadStageData(stageId: string): Promise<StageStoreData | null> {
  try {
    // Read the version and body from one snapshot; a concurrent writer cannot
    // leave this tab with scenes from a different revision than its CAS baseline.
    return await db.transaction(
      'r',
      [db.stages, db.scenes, db.chatSessions, db.stageOutlines],
      async () => {
        const stage = await db.stages.get(stageId);
        if (!stage || stage.conflictDraft) return null;
        const scenes = await db.scenes.where('stageId').equals(stageId).sortBy('order');
        const chats = await loadChatSessions(stageId);
        const outlines = (await db.stageOutlines.get(stageId))?.outlines ?? [];
        return {
          stage,
          scenes,
          chats,
          outlines,
          contentRevision: storedRevision(stage),
          currentSceneId: stage.currentSceneId || scenes[0]?.id || null,
          snapshotCursor: stage.snapshotCursor,
          snapshotSessionId: stage.snapshotSessionId,
        };
      },
    );
  } catch (error) {
    log.error('Failed to load stage:', error);
    return null;
  }
}

/**
 * Delete stage and all related data
 */
export async function deleteStageData(stageId: string): Promise<void> {
  try {
    // Collect scene ids before deletion so we can sweep per-scene localStorage
    // keys (quiz draft / submitted answers / graded results).
    const sceneIds = (await db.scenes.where('stageId').equals(stageId).toArray()).map((s) => s.id);

    // Delete stage
    await db.stages.delete(stageId);

    // Delete scenes
    await db.scenes.where('stageId').equals(stageId).delete();

    // Delete chat sessions and playback state
    await deleteChatSessions(stageId);
    await clearPlaybackState(stageId);

    // Sweep quiz persistence keys for each deleted scene.
    for (const sceneId of sceneIds) {
      clearAllForScene(sceneId);
    }

    log.info(`Deleted stage: ${stageId}`);
  } catch (error) {
    log.error('Failed to delete stage:', error);
    throw error;
  }
}

/**
 * List all stages
 */
export async function listStages(): Promise<StageListItem[]> {
  try {
    const stages = (await db.stages.orderBy('updatedAt').reverse().toArray()).filter(
      (record) => !record.conflictDraft,
    );

    const stageList: StageListItem[] = await Promise.all(
      stages.map(async (stage) => {
        const sceneCount = await db.scenes.where('stageId').equals(stage.id).count();

        return {
          id: stage.id,
          name: stage.name,
          description: stage.description,
          sceneCount,
          createdAt: stage.createdAt,
          updatedAt: stage.updatedAt,
          interactiveMode: stage.interactiveMode,
        };
      }),
    );

    return stageList;
  } catch (error) {
    log.error('Failed to list stages:', error);
    return [];
  }
}

type ThumbnailMediaElement = {
  type: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

type ThumbnailSlide = import('../types/slides').Slide;

function isGeneratedMediaRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_(img|vid)_[\w-]+$/i.test(value);
}

function isLegacySequentialVideoRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_vid_\d+$/i.test(value);
}

function getThumbnailMediaRef(element: ThumbnailMediaElement): string | undefined {
  if (element.type === 'image' && isGeneratedMediaRef(element.src)) {
    return element.src;
  }
  if (element.type === 'video') {
    if (isGeneratedMediaRef(element.mediaRef)) return element.mediaRef;
    if (isGeneratedMediaRef(element.src)) return element.src;
  }
  return undefined;
}

function getMediaRecordElementId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

function blobWithType(blob: Blob, mimeType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

function revokeObjectUrl(url: string | undefined) {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function revokeThumbnailSlideMediaUrls(slides: Record<string, ThumbnailSlide>) {
  for (const slide of Object.values(slides)) {
    for (const element of slide.elements as ThumbnailMediaElement[]) {
      if (element.type === 'image' || element.type === 'video') {
        revokeObjectUrl(element.src);
      }
      if (element.type === 'video') {
        revokeObjectUrl(element.poster);
      }
    }
  }
}

/**
 * Get first slide scene's canvas data for each stage (for thumbnail preview).
 * Also resolves generated image/video refs from mediaFiles so thumbnails show real media.
 * Returns a map of stageId -> Slide (canvas data with resolved media)
 */
export async function getFirstSlideByStages(
  stageIds: string[],
): Promise<Record<string, ThumbnailSlide>> {
  const result: Record<string, ThumbnailSlide> = {};
  try {
    await Promise.all(
      stageIds.map(async (stageId) => {
        const scenes = await db.scenes.where('stageId').equals(stageId).sortBy('order');
        const firstSlide = scenes.find((s) => s.content?.type === 'slide');
        if (firstSlide && firstSlide.content.type === 'slide') {
          const slide = structuredClone(firstSlide.content.canvas);

          const mediaElements = slide.elements.filter((el) =>
            getThumbnailMediaRef(el as ThumbnailMediaElement),
          );
          if (mediaElements.length > 0) {
            const mediaRecords = await db.mediaFiles.where('stageId').equals(stageId).toArray();
            const videoRecords = mediaRecords.filter(
              (record) => !record.error && record.type === 'video',
            );
            const mediaMap = new Map(
              mediaRecords.map((record) => [getMediaRecordElementId(record.id), record] as const),
            );

            for (const el of mediaElements as ThumbnailMediaElement[]) {
              const mediaRef = getThumbnailMediaRef(el);
              const exactRecord = mediaRef ? mediaMap.get(mediaRef) : undefined;
              const usableExactRecord = exactRecord && !exactRecord.error ? exactRecord : undefined;
              const legacyRecord =
                !exactRecord &&
                el.type === 'video' &&
                isLegacySequentialVideoRef(mediaRef) &&
                videoRecords.length === 1
                  ? videoRecords[0]
                  : undefined;
              const record = usableExactRecord ?? legacyRecord;

              if (!mediaRef || !record) {
                if (el.type === 'image') {
                  // Clear unresolved placeholder so BaseImageElement won't subscribe
                  // to the global media store (which may have stale data from another course)
                  el.src = '';
                }
                continue;
              }

              if (el.type === 'image' && record.type === 'image') {
                el.src = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
              } else if (el.type === 'video' && record.type === 'video') {
                el.src = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
                if (record.poster) {
                  el.poster = URL.createObjectURL(blobWithType(record.poster, 'image/jpeg'));
                }
              } else if (el.type === 'image') {
                el.src = '';
              }
            }
          }

          result[stageId] = slide;
        }
      }),
    );
  } catch (error) {
    log.error('Failed to load thumbnails:', error);
  }
  return result;
}

/**
 * Rename a stage (updates only the name field in IndexedDB)
 */
export async function renameStage(stageId: string, newName: string): Promise<void> {
  try {
    await db.transaction('rw', db.stages, async () => {
      const previous = await db.stages.get(stageId);
      if (!previous) throw new Error('Classroom no longer exists');
      const revision = storedRevision(previous)! + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Classroom revision limit reached');
      await db.stages.update(stageId, {
        name: newName,
        updatedAt: Date.now(),
        contentRevision: revision,
      });
    });
    log.info(`Renamed stage ${stageId} to "${newName}"`);
  } catch (error) {
    log.error('Failed to rename stage:', error);
    throw error;
  }
}

/**
 * Check if stage exists
 */
export async function stageExists(stageId: string): Promise<boolean> {
  try {
    const stage = await db.stages.get(stageId);
    return !!stage;
  } catch (error) {
    log.error('Failed to check stage existence:', error);
    return false;
  }
}

/** Preserve a conflicted draft as a new classroom without touching its source. */
export async function saveStageCopy(source: StageStoreData): Promise<string> {
  const sourceId = source.stage.id;
  const stageId = nanoid();
  const data = structuredClone(source);
  const sceneIds = new Map(data.scenes.map((scene) => [scene.id, nanoid()]));
  data.stage = { ...data.stage, id: stageId, name: `${data.stage.name} (copy)` };
  data.contentRevision = null;
  delete data.snapshotCursor;
  delete data.snapshotSessionId;
  data.scenes = data.scenes.map((scene) => ({ ...scene, id: sceneIds.get(scene.id)!, stageId }));
  data.currentSceneId = sceneIds.get(data.currentSceneId ?? '') ?? null;
  data.chats = data.chats.map((chat) => ({
    ...chat,
    id: nanoid(),
    sceneId: chat.sceneId ? sceneIds.get(chat.sceneId) : undefined,
  }));
  await db.transaction(
    'rw',
    [db.stages, db.scenes, db.chatSessions, db.stageOutlines, db.mediaFiles, db.generatedAgents],
    async () => {
      const media = await db.mediaFiles.where('stageId').equals(sourceId).toArray();
      await db.mediaFiles.bulkPut(
        media.map((record) => ({
          ...record,
          stageId,
          id: `${stageId}:${getMediaRecordElementId(record.id)}`,
        })),
      );
      const agents = await db.generatedAgents.where('stageId').equals(sourceId).toArray();
      const agentIds = new Map(agents.map((agent) => [agent.id, `gen-${nanoid()}`]));
      const references = new Map([
        ...sceneIds,
        ...agentIds,
        [sourceId, stageId] as [string, string],
      ]);
      const remapReferences = (value: unknown): unknown => {
        if (typeof value === 'string') return references.get(value) ?? value;
        if (Array.isArray(value)) return value.map(remapReferences);
        if (
          value &&
          typeof value === 'object' &&
          Object.getPrototypeOf(value) === Object.prototype
        ) {
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, remapReferences(item)]),
          );
        }
        return value;
      };
      await db.generatedAgents.bulkPut(
        agents.map((agent) => ({ ...agent, id: agentIds.get(agent.id)!, stageId })),
      );
      await saveStageData(stageId, remapReferences(data) as StageStoreData);
    },
  );
  return stageId;
}

/** Recovery uses existing non-indexed stage rows, so no schema upgrade is required. */
export async function retainConflictDraft(id: string, payload: StageStoreData): Promise<void> {
  const now = Date.now();
  await db.stages.put({
    id: `save-conflict:${id}`,
    name: `${payload.stage.name} (unsaved draft)`,
    createdAt: now,
    updatedAt: now,
    conflictDraft: { payload: structuredClone(payload) },
  });
}
export async function loadConflictDrafts(): Promise<{ id: string; payload: StageStoreData }[]> {
  return (await db.stages.toArray()).flatMap((row) =>
    row.conflictDraft
      ? [{ id: row.id.slice('save-conflict:'.length), payload: row.conflictDraft.payload }]
      : [],
  );
}
export async function deleteConflictDraft(id: string): Promise<void> {
  await db.stages.delete(`save-conflict:${id}`);
}
