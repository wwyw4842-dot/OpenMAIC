import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Stage, Scene, StageMode } from '@/lib/types/stage';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { ChatSession } from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import type { StageStoreData, StageHistoryWrite } from '@/lib/utils/stage-storage';

export interface StagePersistenceOwner {
  id: string;
  stageId: string;
  revision: number | null;
  conflicted?: boolean;
}
interface StageSaveOptions {
  owner?: StagePersistenceOwner;
  payload?: StageStoreData;
  writeHistory?: StageHistoryWrite;
  cancelPending?: boolean;
  onCommitted?: (data: StageStoreData) => void;
}

const log = createLogger('StageStore');

const stageSaveTail = new Map<string, Promise<void>>();
let loadRequestId = 0;

function enqueueStageSave(stageId: string, job: () => Promise<void>): Promise<void> {
  const previous = stageSaveTail.get(stageId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(job);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  stageSaveTail.set(stageId, tail);
  void tail.then(() => {
    if (stageSaveTail.get(stageId) === tail) stageSaveTail.delete(stageId);
  });
  return current;
}

/** Virtual scene ID used when the user navigates to a page still being generated */
export const PENDING_SCENE_ID = '__pending__';

type ToolbarState = 'design' | 'ai';

interface StageState {
  // Stage info
  stage: Stage | null;
  editRevision: number;
  failedSaveStageIds: string[];
  persistenceOwner: StagePersistenceOwner | null;
  conflictDrafts: { id: string; stageId: string; name: string }[];

  // Scenes
  scenes: Scene[];
  currentSceneId: string | null;

  // Chats
  chats: ChatSession[];

  // Mode
  mode: StageMode;

  // UI state
  toolbarState: ToolbarState;

  // Transient generation state (not persisted)
  generatingOutlines: SceneOutline[];

  // Persisted outlines for resume-on-refresh
  outlines: SceneOutline[];

  // Transient generation tracking (not persisted)
  generationEpoch: number;
  generationStatus: 'idle' | 'generating' | 'paused' | 'completed' | 'error';
  currentGeneratingOrder: number;
  failedOutlines: SceneOutline[];

  // Actions
  setStage: (stage: Stage) => void;
  updateStage: (stage: Stage) => void;
  setScenes: (scenes: Scene[]) => void;
  addScene: (scene: Scene) => void;
  updateScene: (sceneId: string, updates: Partial<Scene>) => void;
  deleteScene: (sceneId: string) => void;
  setCurrentSceneId: (sceneId: string | null) => void;
  setChats: (chats: ChatSession[]) => void;
  setMode: (mode: StageMode) => void;
  setToolbarState: (state: ToolbarState) => void;
  setGeneratingOutlines: (outlines: SceneOutline[]) => void;
  setOutlines: (outlines: SceneOutline[]) => void;
  setGenerationStatus: (status: 'idle' | 'generating' | 'paused' | 'completed' | 'error') => void;
  setCurrentGeneratingOrder: (order: number) => void;
  bumpGenerationEpoch: () => void;
  addFailedOutline: (outline: SceneOutline) => void;
  clearFailedOutlines: () => void;
  retryFailedOutline: (outlineId: string) => void;

  // Getters
  getCurrentScene: () => Scene | null;
  getSceneById: (sceneId: string) => Scene | null;
  getSceneIndex: (sceneId: string) => number;

  // Storage
  saveToStorage: (options?: StageSaveOptions) => Promise<void>;
  retryFailedSaves: () => Promise<void>;
  loadFromStorage: (stageId: string, reload?: boolean) => Promise<void>;
  loadLatestForConflict: (draftId: string) => Promise<void>;
  saveConflictCopy: (draftId: string) => Promise<string>;
  clearStore: () => void;
}

const useStageStoreBase = create<StageState>()((set, get) => ({
  // Initial state
  stage: null,
  editRevision: 0,
  failedSaveStageIds: [],
  persistenceOwner: null,
  conflictDrafts: [],
  scenes: [],
  currentSceneId: null,
  chats: [],
  mode: 'playback',
  toolbarState: 'ai',
  generatingOutlines: [],
  outlines: [],
  generationEpoch: 0,
  generationStatus: 'idle' as const,
  currentGeneratingOrder: -1,
  failedOutlines: [],

  // Actions
  setStage: (stage) => {
    loadRequestId += 1;
    flushPendingSave(get().stage?.id);
    set((s) => ({
      stage,
      persistenceOwner: {
        id: nanoid(),
        stageId: stage.id,
        revision: (stage as Stage & { contentRevision?: number }).contentRevision ?? null,
      },
      scenes: [],
      currentSceneId: null,
      chats: [],
      outlines: [],
      generationEpoch: s.generationEpoch + 1,
      editRevision: s.editRevision + 1,
    }));
    debouncedSave();
  },

  setScenes: (scenes) => {
    set((state) => ({ scenes, editRevision: state.editRevision + 1 }));
    // Auto-select first scene if no current scene
    if (!get().currentSceneId && scenes.length > 0) {
      set({ currentSceneId: scenes[0].id });
    }
    debouncedSave();
  },

  updateStage: (stage) => {
    if (get().stage?.id !== stage.id) {
      get().setStage(stage);
      return;
    }
    set((state) => ({ stage, editRevision: state.editRevision + 1 }));
    debouncedSave();
  },

  addScene: (scene) => {
    const currentStage = get().stage;
    // Ignore scenes from different stages (prevents race condition during generation)
    if (!currentStage || scene.stageId !== currentStage.id) {
      log.warn(
        `Ignoring scene "${scene.title}" - stageId mismatch (scene: ${scene.stageId}, current: ${currentStage?.id})`,
      );
      return;
    }
    const scenes = [...get().scenes, scene];
    // Remove the matching outline from generatingOutlines (match by order)
    const generatingOutlines = get().generatingOutlines.filter((o) => o.order !== scene.order);
    // Auto-switch from pending page to the newly generated scene
    const shouldSwitch = get().currentSceneId === PENDING_SCENE_ID;
    set({
      editRevision: get().editRevision + 1,
      scenes,
      generatingOutlines,
      ...(shouldSwitch ? { currentSceneId: scene.id } : {}),
    });
    debouncedSave();
  },

  updateScene: (sceneId, updates) => {
    const scenes = get().scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, ...updates } : scene,
    );
    set((state) => ({ scenes, editRevision: state.editRevision + 1 }));
    debouncedSave();
  },

  deleteScene: (sceneId) => {
    const scenes = get().scenes.filter((scene) => scene.id !== sceneId);
    const currentSceneId = get().currentSceneId;

    // If deleted scene was current, select next or previous
    if (currentSceneId === sceneId) {
      const index = get().getSceneIndex(sceneId);
      const newIndex = index < scenes.length ? index : scenes.length - 1;
      set({
        editRevision: get().editRevision + 1,
        scenes,
        currentSceneId: scenes[newIndex]?.id || null,
      });
    } else {
      set((state) => ({ scenes, editRevision: state.editRevision + 1 }));
    }
    debouncedSave();
  },

  setCurrentSceneId: (sceneId) => {
    set((state) => ({ currentSceneId: sceneId, editRevision: state.editRevision + 1 }));
    debouncedSave();
  },

  setChats: (chats) => {
    set((state) => ({ chats, editRevision: state.editRevision + 1 }));
    debouncedSave();
  },

  setMode: (mode) => set({ mode }),

  setToolbarState: (toolbarState) => set({ toolbarState }),

  setGeneratingOutlines: (generatingOutlines) => set({ generatingOutlines }),

  setOutlines: (outlines) => {
    set((state) => ({ outlines, editRevision: state.editRevision + 1 }));
    debouncedSave();
  },

  setGenerationStatus: (generationStatus) => set({ generationStatus }),

  setCurrentGeneratingOrder: (currentGeneratingOrder) => set({ currentGeneratingOrder }),

  bumpGenerationEpoch: () => set((s) => ({ generationEpoch: s.generationEpoch + 1 })),

  addFailedOutline: (outline) => {
    const existed = get().failedOutlines.some((o) => o.id === outline.id);
    if (existed) return;
    set({ failedOutlines: [...get().failedOutlines, outline] });
  },

  clearFailedOutlines: () => set({ failedOutlines: [] }),

  retryFailedOutline: (outlineId) => {
    set({
      failedOutlines: get().failedOutlines.filter((o) => o.id !== outlineId),
    });
  },

  // Getters
  getCurrentScene: () => {
    const { scenes, currentSceneId } = get();
    if (!currentSceneId) return null;
    return scenes.find((s) => s.id === currentSceneId) || null;
  },

  getSceneById: (sceneId) => {
    return get().scenes.find((s) => s.id === sceneId) || null;
  },

  getSceneIndex: (sceneId) => {
    return get().scenes.findIndex((s) => s.id === sceneId);
  },

  // Storage methods
  saveToStorage: async (options) => {
    const captured = captureStageSave();
    const payload = options?.payload ?? captured?.payload;
    if (!payload?.stage.id) return;
    const owner = options?.owner ?? captured?.owner;
    if (!owner || owner.stageId !== payload.stage.id)
      throw new Error('Missing classroom save owner');
    if (options?.cancelPending !== false) cancelPendingSave(payload.stage.id);
    await persistPayload(
      payload.stage.id,
      structuredClone(payload),
      owner,
      undefined,
      options?.writeHistory,
      options?.onCommitted,
    );
  },

  retryFailedSaves: async () => {
    // Queue the retained payload now, so a subsequent edit always saves after it.
    const retries = [...failedSaves].map(([stageId, retained]) =>
      persistPayload(
        stageId,
        retained.payload,
        retained.owner,
        retained,
        retained.writeHistory,
        retained.onCommitted,
      ),
    );
    const results = await Promise.allSettled(retries);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  },

  loadFromStorage: async (stageId: string, reload = false) => {
    const requestId = ++loadRequestId;
    const startingState = get();
    flushPendingSave(startingState.stage?.id);
    try {
      await stageSaveTail.get(stageId);
      // Skip IndexedDB load if the store already has this stage with scenes
      // (e.g. navigated from generation-preview with fresh in-memory data)
      const currentState = get();
      if (!reload && currentState.stage?.id === stageId && currentState.scenes.length > 0) {
        log.info('Stage already loaded in memory, skipping IndexedDB load:', stageId);
        return;
      }

      const { loadStageData, loadConflictDrafts } = await import('@/lib/utils/stage-storage');
      const data = await loadStageData(stageId);
      for (const draft of await loadConflictDrafts()) {
        if (!conflictSaves.has(draft.id))
          conflictSaves.set(draft.id, {
            payload: draft.payload,
            owner: {
              id: draft.id,
              stageId: draft.payload.stage.id,
              revision: draft.payload.contentRevision ?? null,
              conflicted: true,
            },
          });
      }
      publishSaveFailures();

      // Load outlines for resume-on-refresh
      const outlines = data?.outlines ?? [];

      // Navigation or edits that happened during the read own the current UI.
      if (requestId !== loadRequestId || get().editRevision !== startingState.editRevision) return;
      if (data) {
        set({
          editRevision: get().editRevision + 1,
          stage: data.stage,
          persistenceOwner: { id: nanoid(), stageId, revision: data.contentRevision ?? 0 },
          scenes: data.scenes,
          currentSceneId: data.currentSceneId,
          chats: data.chats,
          outlines,
          // Compute generatingOutlines from persisted outlines minus completed scenes
          generatingOutlines: outlines.filter((o) => !data.scenes.some((s) => s.order === o.order)),
        });
        log.info('Loaded from storage:', stageId);
      } else {
        log.warn('No data found for stage:', stageId);
      }
    } catch (error) {
      log.error('Failed to load from storage:', error);
      throw error;
    }
  },

  loadLatestForConflict: async (draftId) => {
    const retained = conflictSaves.get(draftId);
    if (!retained) return;
    const request = get();
    const captured = captureStageSave();
    if (captured?.owner === retained.owner) {
      // Cancel only the timer captured by this action. Edits made while the
      // backup awaits must keep their own pending timer.
      cancelPendingSave(retained.owner.stageId);
      retained.payload = captured.payload;
      await retainConflictDraftSerialized(draftId, retained.payload, retained);
    } else {
      flushPendingSave(retained.owner.stageId);
    }
    await stageSaveTail.get(retained.owner.stageId);
    // A later edit/navigation cancels this read and preserves the new draft.
    if (
      get().persistenceOwner !== request.persistenceOwner ||
      get().editRevision !== request.editRevision
    ) {
      const newer = captureStageSave();
      if (newer?.owner === retained.owner) {
        const saved = { owner: retained.owner, payload: newer.payload };
        conflictSaves.set(draftId, saved);
        await retainConflictDraftSerialized(draftId, saved.payload, saved);
      }
      publishSaveFailures();
      return;
    }
    await get().loadFromStorage(retained.owner.stageId, true);
  },

  saveConflictCopy: async (draftId) => {
    const retained = conflictSaves.get(draftId);
    if (!retained) throw new Error('Conflict draft no longer exists');
    const request = get();
    const captured = captureStageSave();
    if (captured?.owner === retained.owner) retained.payload = captured.payload;
    const source = structuredClone(retained.payload);
    if (captured?.owner === retained.owner) cancelPendingSave(retained.owner.stageId);
    else flushPendingSave(retained.owner.stageId);
    await stageSaveTail.get(retained.owner.stageId);
    const { saveStageCopy } = await import('@/lib/utils/stage-storage');
    const stageId = await saveStageCopy(source);
    const current = captureStageSave();
    if (current?.owner === retained.owner && get().editRevision !== request.editRevision) {
      const newer = { owner: retained.owner, payload: current.payload };
      conflictSaves.set(draftId, newer);
      await retainConflictDraftSerialized(draftId, newer.payload, newer);
    } else if (conflictSaves.get(draftId) === retained) {
      await deleteConflictDraftSerialized(draftId, retained);
    }
    publishSaveFailures();
    // Opening the copy is explicit; completion never changes route or newer edits.
    return stageId;
  },

  clearStore: () => {
    loadRequestId += 1;
    flushPendingSave(get().stage?.id);
    set((s) => ({
      stage: null,
      persistenceOwner: null,
      scenes: [],
      currentSceneId: null,
      chats: [],
      outlines: [],
      generationEpoch: s.generationEpoch + 1,
      editRevision: s.editRevision + 1,
      generationStatus: 'idle' as const,
      currentGeneratingOrder: -1,
      failedOutlines: [],
      generatingOutlines: [],
    }));
    log.info('Store cleared');
  },
}));

export const useStageStore = createSelectors(useStageStoreBase);

// ==================== Debounced Save ====================

/**
 * Debounced version of saveToStorage to prevent excessive writes
 * Waits 500ms after the last change before saving
 */
const pendingSaves = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; save: () => Promise<void> }
>();

function cancelPendingSave(stageId: string) {
  const pending = pendingSaves.get(stageId);
  if (pending) clearTimeout(pending.timer);
  pendingSaves.delete(stageId);
}

function flushPendingSave(stageId?: string) {
  if (!stageId) return;
  const pending = pendingSaves.get(stageId);
  if (!pending) return;
  cancelPendingSave(stageId);
  void pending.save().catch((error) => log.error('Failed to flush classroom:', error));
}

interface RetainedSave {
  owner: StagePersistenceOwner;
  payload: StageStoreData;
  writeHistory?: StageHistoryWrite;
  onCommitted?: (data: StageStoreData) => void;
}
const failedSaves = new Map<string, RetainedSave>();
const conflictSaves = new Map<string, RetainedSave>();
const conflictDraftTails = new Map<string, Promise<void>>();

function queueConflictDraftOperation(id: string, operation: () => Promise<void>): Promise<void> {
  const previous = conflictDraftTails.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  conflictDraftTails.set(id, next);
  void next
    .finally(() => {
      if (conflictDraftTails.get(id) === next) conflictDraftTails.delete(id);
    })
    .catch(() => undefined);
  return next;
}

function retainConflictDraftSerialized(
  id: string,
  payload: StageStoreData,
  expected: RetainedSave,
): Promise<void> {
  return queueConflictDraftOperation(id, async () => {
    if (conflictSaves.get(id) !== expected) return;
    const { retainConflictDraft } = await import('@/lib/utils/stage-storage');
    await retainConflictDraft(id, payload);
  });
}

function deleteConflictDraftSerialized(id: string, expected: RetainedSave): Promise<void> {
  return queueConflictDraftOperation(id, async () => {
    if (conflictSaves.get(id) !== expected) return;
    const { deleteConflictDraft } = await import('@/lib/utils/stage-storage');
    await deleteConflictDraft(id);
    if (conflictSaves.get(id) === expected) conflictSaves.delete(id);
  });
}

function publishSaveFailures() {
  useStageStore.setState({
    failedSaveStageIds: [...failedSaves.keys()],
    conflictDrafts: [...conflictSaves].map(([id, retained]) => ({
      id,
      stageId: retained.owner.stageId,
      name: retained.payload.stage.name,
    })),
  });
}

function persistPayload(
  stageId: string,
  payload: StageStoreData,
  owner: StagePersistenceOwner,
  retry?: RetainedSave,
  writeHistory?: StageHistoryWrite,
  onCommitted?: (data: StageStoreData) => void,
): Promise<void> {
  return enqueueStageSave(stageId, async () => {
    if (retry && failedSaves.get(stageId) !== retry) return;
    try {
      if (payload.scenes.some((scene) => scene.stageId && scene.stageId !== stageId)) {
        throw new Error('Refusing to save scenes that belong to another classroom');
      }
      const { saveStageData, StageSaveConflictError } = await import('@/lib/utils/stage-storage');
      if (owner.conflicted) throw new StageSaveConflictError(stageId, owner.revision, null);
      payload.contentRevision = owner.revision;
      let saved = !writeHistory;
      let metadataOnly = false;
      const committed = await saveStageData(
        stageId,
        payload,
        writeHistory
          ? async (data) => {
              const result = await writeHistory(data);
              saved = result !== false;
              metadataOnly = typeof result === 'object' && result.metadataOnly;
              return result;
            }
          : undefined,
      );
      if (committed.saved) owner.revision = committed.contentRevision;
      // A cancelled history retry has been superseded by navigation or editing.
      // Metadata initialization must not discard an unrelated failed payload.
      if ((!saved || metadataOnly) && !retry) {
        if (saved) onCommitted?.(payload);
        return;
      }
      failedSaves.delete(stageId);
      publishSaveFailures();
      if (saved) onCommitted?.(payload);
    } catch (error) {
      // Keep the exact originating version, including after navigation. A later
      // successful save replaces it, so retry never resurrects an older edit.
      // Retain the history mutation with its body: retrying only the body would
      // lose the undo point or advance the cursor without its atomic scene write.
      const { StageSaveConflictError } = await import('@/lib/utils/stage-storage');
      if (error instanceof StageSaveConflictError) {
        owner.conflicted = true;
        const current = captureStageSave();
        const draft = current?.owner === owner ? current.payload : payload;
        const retained = { payload: structuredClone(draft), owner };
        conflictSaves.set(owner.id, retained);
        failedSaves.delete(stageId);
        // Quota failures keep the in-memory draft and alert. Never mask the conflict.
        try {
          await retainConflictDraftSerialized(owner.id, retained.payload, retained);
        } catch (backupError) {
          log.error('Conflict draft backup failed; keep this tab open:', backupError);
        }
      } else {
        failedSaves.set(stageId, { payload, owner, writeHistory, onCommitted });
      }
      publishSaveFailures();
      throw error;
    }
  });
}

function debouncedSave() {
  const captured = captureStageSave();
  if (!captured) return;
  const { payload, owner } = captured;
  const stageId = payload.stage.id;
  cancelPendingSave(stageId);
  const save = () => persistPayload(stageId, payload, owner);
  const timer = setTimeout(() => {
    pendingSaves.delete(stageId);
    void save().catch((error) => log.error('Failed to autosave classroom:', error));
  }, 500);
  pendingSaves.set(stageId, { timer, save });
}

/** Capture body and its client lineage together before any queued history work. */
export function captureStageSave(): {
  payload: StageStoreData;
  owner: StagePersistenceOwner;
} | null {
  const { stage, scenes, currentSceneId, chats, outlines, persistenceOwner } =
    useStageStore.getState();
  if (!stage) return null;
  let owner = persistenceOwner;
  if (!owner || owner.stageId !== stage.id) {
    owner = {
      id: nanoid(),
      stageId: stage.id,
      revision: (stage as Stage & { contentRevision?: number }).contentRevision ?? null,
    };
    useStageStore.setState({ persistenceOwner: owner });
  }
  return {
    owner,
    payload: structuredClone({
      stage,
      scenes,
      currentSceneId,
      chats,
      outlines,
      contentRevision: owner.revision,
    }),
  };
}
// Raw injected/test stores may clear their active stage; discard its client lineage.
useStageStore.subscribe((state) => {
  if (!state.stage && state.persistenceOwner) useStageStore.setState({ persistenceOwner: null });
});
