import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { db, type Snapshot } from '@/lib/utils/database';
import type { StageStoreData } from '@/lib/utils/stage-storage';
import { useStageStore, captureStageSave } from './stage';
import type { Scene } from '@/lib/types/stage';

const SNAPSHOT_LIMIT = 20;
let historyTail: Promise<void> = Promise.resolve();
function enqueueHistory(job: () => Promise<void>): Promise<void> {
  const current = historyTail.then(job);
  historyTail = current.catch(() => undefined);
  return current;
}
function cloneScenes(scenes: Scene[]): Scene[] {
  return structuredClone(scenes);
}
async function snapshotsFor(stageId: string, sessionId?: string): Promise<Snapshot[]> {
  const rows = await db.snapshots.where('stageId').equals(stageId).sortBy('id');
  return sessionId ? rows.filter((row) => (row.sessionId ?? stageId) === sessionId) : rows;
}
function active(stageId: string, revision: number) {
  const state = useStageStore.getState();
  return state.stage?.id === stageId && state.editRevision === revision;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
function sceneFingerprint(scenes: Scene[]): string {
  // Storage normalizes ownership and timestamps; compare the actual editable body.
  return JSON.stringify(
    canonical(
      scenes.map(
        ({ stageId: _stageId, createdAt: _createdAt, updatedAt: _updatedAt, ...body }) => body,
      ),
    ),
  );
}
async function initializeHistory(data: StageStoreData) {
  const stageId = data.stage.id;
  const record = await db.stages.get(stageId);
  let sessionId = record?.snapshotSessionId;
  let rows = await snapshotsFor(stageId, sessionId);
  let cursor = record?.snapshotCursor;
  if (!Number.isInteger(cursor) || cursor! < 0 || cursor! >= rows.length) {
    const savedScenes = record
      ? await db.scenes.where('stageId').equals(stageId).sortBy('order')
      : data.scenes;
    const body = sceneFingerprint(savedScenes);
    cursor = rows.findLastIndex((row) => sceneFingerprint(row.slides) === body);
    if (cursor < 0 && rows.length) {
      // Keep unmatched older rows intact, but never expose them as current undo history.
      sessionId = `${stageId}:${nanoid()}`;
      rows = [];
    }
  }
  const created = !rows.length;
  if (created) {
    sessionId ??= stageId;
    const first = {
      stageId,
      sessionId,
      index: data.scenes.findIndex((scene) => scene.id === data.currentSceneId),
      slides: cloneScenes(data.scenes),
    };
    const id = await db.snapshots.add(first);
    rows = [{ ...first, id }];
    cursor = 0;
  }
  data.snapshotCursor = cursor!;
  data.snapshotSessionId = sessionId ?? rows[0]?.sessionId ?? stageId;
  return {
    rows,
    cursor: cursor!,
    sessionId: data.snapshotSessionId,
    unchanged:
      !created &&
      record?.snapshotCursor === data.snapshotCursor &&
      record?.snapshotSessionId === data.snapshotSessionId,
  };
}
export interface SnapshotState {
  snapshotCursor: number;
  snapshotLength: number;
  historyStageId: string | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  setSnapshotCursor: (cursor: number) => void;
  setSnapshotLength: (length: number) => void;
  initSnapshotDatabase: () => Promise<void>;
  addSnapshot: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}
export const useSnapshotStore = create<SnapshotState>((set, get) => {
  const move = (delta: number) => {
    const request = useStageStore.getState();
    const captured = captureStageSave();
    const payload = captured?.payload;
    const stageId = payload?.stage.id;
    if (!stageId || !payload) return Promise.resolve();
    return enqueueHistory(async () => {
      if (!active(stageId, request.editRevision) || get().historyStageId !== stageId) return;
      let restored: StageStoreData | undefined;
      let cursor = -1;
      let length = 0;
      await request.saveToStorage({
        payload,
        owner: captured!.owner,
        writeHistory: async (data) => {
          const record = await db.stages.get(stageId);
          const rows = await snapshotsFor(stageId, record?.snapshotSessionId);
          if (!active(stageId, request.editRevision)) return false;
          cursor = (record?.snapshotCursor ?? get().snapshotCursor) + delta;
          const snapshot = rows[cursor];
          if (
            !snapshot ||
            snapshot.slides.some((scene) => scene.stageId && scene.stageId !== stageId)
          )
            return false;
          const sceneIndex = Math.max(0, Math.min(snapshot.index, snapshot.slides.length - 1));
          data.scenes = cloneScenes(snapshot.slides);
          data.currentSceneId = snapshot.slides[sceneIndex]?.id ?? null;
          data.snapshotCursor = cursor;
          restored = data;
          length = rows.length;
        },
        onCommitted: () => {
          if (!restored || !active(stageId, request.editRevision)) return;
          // Publish only after the scenes and cursor commit together. Consecutive
          // queued undo commands keep the same editRevision and remain ordered.
          useStageStore.setState({
            scenes: restored.scenes,
            currentSceneId: restored.currentSceneId,
          });
          set({ snapshotCursor: cursor, snapshotLength: length });
        },
      });
    });
  };
  return {
    snapshotCursor: -1,
    snapshotLength: 0,
    historyStageId: null,
    canUndo: () =>
      get().historyStageId === useStageStore.getState().stage?.id && get().snapshotCursor > 0,
    canRedo: () =>
      get().historyStageId === useStageStore.getState().stage?.id &&
      get().snapshotCursor < get().snapshotLength - 1,
    setSnapshotCursor: (snapshotCursor) => set({ snapshotCursor }),
    setSnapshotLength: (snapshotLength) => set({ snapshotLength }),
    initSnapshotDatabase: () => {
      const request = useStageStore.getState();
      const captured = captureStageSave();
      const payload = captured?.payload;
      if (!payload) return Promise.resolve();
      const stageId = payload.stage.id;
      return enqueueHistory(async () => {
        let cursor = -1;
        let length = 0;
        await request.saveToStorage({
          payload,
          owner: captured!.owner,
          cancelPending: false,
          writeHistory: async (data) => {
            const history = await initializeHistory(data);
            cursor = history.cursor;
            length = history.rows.length;
            return { metadataOnly: true, unchanged: history.unchanged };
          },
          onCommitted: () => {
            if (active(stageId, request.editRevision))
              set({ historyStageId: stageId, snapshotCursor: cursor, snapshotLength: length });
          },
        });
      });
    },
    addSnapshot: () => {
      const request = useStageStore.getState();
      const captured = captureStageSave();
      const payload = captured?.payload;
      if (!payload) return Promise.resolve();
      const stageId = payload.stage.id;
      const index = payload.scenes.findIndex((scene) => scene.id === payload.currentSceneId);
      return enqueueHistory(async () => {
        let length = 0;
        await request.saveToStorage({
          payload,
          owner: captured!.owner,
          cancelPending: active(stageId, request.editRevision),
          writeHistory: async (data) => {
            const { rows, cursor, sessionId } = await initializeHistory(data);
            const removed = rows
              .slice(cursor + 1)
              .flatMap((row) => (row.id === undefined ? [] : [row.id]));
            const kept = rows.slice(0, cursor + 1);
            while (kept.length >= SNAPSHOT_LIMIT) {
              const oldest = kept.shift();
              if (oldest?.id !== undefined) removed.push(oldest.id);
            }
            if (removed.length) await db.snapshots.bulkDelete(removed);
            const previous = kept.at(-1);
            if (previous?.id !== undefined) await db.snapshots.update(previous.id, { index });
            await db.snapshots.add({ stageId, sessionId, index, slides: cloneScenes(data.scenes) });
            length = kept.length + 1;
            data.snapshotCursor = length - 1;
            // A newer explicit save may enter the classroom queue before this
            // history job. Keep the captured undo point without replacing its
            // newer durable classroom body.
            if (!active(stageId, request.editRevision)) return { metadataOnly: true };
          },
          onCommitted: () => {
            if (
              useStageStore.getState().stage?.id === stageId &&
              useStageStore.getState().persistenceOwner === captured!.owner
            )
              set({ historyStageId: stageId, snapshotCursor: length - 1, snapshotLength: length });
          },
        });
      });
    },
    undo: () => move(-1),
    redo: () => move(1),
  };
});
