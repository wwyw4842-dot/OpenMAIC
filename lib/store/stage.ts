import { create } from 'zustand';
import type { Stage, Scene, StageMode } from '@/lib/types/stage';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { ChatSession } from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import type { StageStoreData } from '@/lib/utils/stage-storage';

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
  saveToStorage: () => Promise<void>;
  retryFailedSaves: () => Promise<void>;
  loadFromStorage: (stageId: string) => Promise<void>;
  clearStore: () => void;
}

const useStageStoreBase = create<StageState>()((set, get) => ({
  // Initial state
  stage: null,
  editRevision: 0,
  failedSaveStageIds: [],
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
  saveToStorage: async () => {
    const { stage, scenes, currentSceneId, chats, outlines } = get();
    if (!stage?.id) return;
    cancelPendingSave(stage.id);
    await persistPayload(
      stage.id,
      structuredClone({ stage, scenes, currentSceneId, chats, outlines }),
    );
  },

  retryFailedSaves: async () => {
    // Queue the retained payload now, so a subsequent edit always saves after it.
    const retries = [...failedSaves].map(([stageId, payload]) =>
      persistPayload(stageId, payload, true),
    );
    const results = await Promise.allSettled(retries);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  },

  loadFromStorage: async (stageId: string) => {
    const requestId = ++loadRequestId;
    const startingState = get();
    flushPendingSave(startingState.stage?.id);
    try {
      await stageSaveTail.get(stageId);
      // Skip IndexedDB load if the store already has this stage with scenes
      // (e.g. navigated from generation-preview with fresh in-memory data)
      const currentState = get();
      if (currentState.stage?.id === stageId && currentState.scenes.length > 0) {
        log.info('Stage already loaded in memory, skipping IndexedDB load:', stageId);
        return;
      }

      const { loadStageData } = await import('@/lib/utils/stage-storage');
      const data = await loadStageData(stageId);

      // Load outlines for resume-on-refresh
      const { db } = await import('@/lib/utils/database');
      const outlinesRecord = await db.stageOutlines.get(stageId);
      const outlines = outlinesRecord?.outlines || [];

      // Navigation or edits that happened during the read own the current UI.
      if (requestId !== loadRequestId || get().editRevision !== startingState.editRevision) return;
      if (data) {
        set({
          editRevision: get().editRevision + 1,
          stage: data.stage,
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

  clearStore: () => {
    loadRequestId += 1;
    flushPendingSave(get().stage?.id);
    set((s) => ({
      stage: null,
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

const failedSaves = new Map<string, StageStoreData>();

function publishSaveFailures() {
  useStageStore.setState({ failedSaveStageIds: [...failedSaves.keys()] });
}

function persistPayload(stageId: string, payload: StageStoreData, retry = false): Promise<void> {
  return enqueueStageSave(stageId, async () => {
    if (retry && failedSaves.get(stageId) !== payload) return;
    try {
      if (payload.scenes.some((scene) => scene.stageId && scene.stageId !== stageId)) {
        throw new Error('Refusing to save scenes that belong to another classroom');
      }
      const { saveStageData } = await import('@/lib/utils/stage-storage');
      await saveStageData(stageId, payload);
      failedSaves.delete(stageId);
      publishSaveFailures();
    } catch (error) {
      // Keep the exact originating version, including after navigation. A later
      // successful save replaces it, so retry never resurrects an older edit.
      failedSaves.set(stageId, payload);
      publishSaveFailures();
      throw error;
    }
  });
}

function debouncedSave() {
  const { stage, scenes, currentSceneId, chats, outlines } = useStageStore.getState();
  if (!stage) return;
  const stageId = stage.id;
  const payload = structuredClone({ stage, scenes, currentSceneId, chats, outlines });
  cancelPendingSave(stageId);
  const save = () => persistPayload(stageId, payload);
  const timer = setTimeout(() => {
    pendingSaves.delete(stageId);
    void save().catch((error) => log.error('Failed to autosave classroom:', error));
  }, 500);
  pendingSaves.set(stageId, { timer, save });
}
