import { create } from 'zustand';
import { db, type Snapshot } from '@/lib/utils/database';
import { useStageStore } from './stage';
import type { Scene } from '@/lib/types/stage';

const SNAPSHOT_LIMIT = 20;

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

function cloneScenes(scenes: Scene[]): Scene[] {
  return JSON.parse(JSON.stringify(scenes)) as Scene[];
}

async function snapshotsFor(stageId: string): Promise<Snapshot[]> {
  return db.snapshots.where('stageId').equals(stageId).sortBy('id');
}

function belongsToStage(snapshot: Snapshot, stageId: string): boolean {
  if (snapshot.stageId !== stageId) return false;
  return snapshot.slides.every((slide) => !slide.stageId || slide.stageId === stageId);
}

export const useSnapshotStore = create<SnapshotState>((set, get) => ({
  snapshotCursor: -1,
  snapshotLength: 0,
  historyStageId: null,

  canUndo: () => get().historyStageId === useStageStore.getState().stage?.id && get().snapshotCursor > 0,
  canRedo: () => get().historyStageId === useStageStore.getState().stage?.id && get().snapshotCursor < get().snapshotLength - 1,

  setSnapshotCursor: (cursor: number) => set({ snapshotCursor: cursor }),
  setSnapshotLength: (length: number) => set({ snapshotLength: length }),

  initSnapshotDatabase: async () => {
    const stageId = useStageStore.getState().stage?.id;
    if (!stageId) return;

    const existing = await snapshotsFor(stageId);
    if (useStageStore.getState().stage?.id !== stageId) return;
    if (
      get().historyStageId === stageId &&
      existing.length > 0 &&
      existing.length === get().snapshotLength
    ) {
      return;
    }

    if (existing.length === 0) {
      const stageStore = useStageStore.getState();
      if (stageStore.stage?.id !== stageId) return;
      await db.snapshots.add({
        stageId,
        sessionId: stageId,
        index: stageStore.getSceneIndex(stageStore.currentSceneId || ''),
        slides: cloneScenes(stageStore.scenes),
      });
      if (useStageStore.getState().stage?.id !== stageId) return;
      set({ historyStageId: stageId, snapshotCursor: 0, snapshotLength: 1 });
      return;
    }

    set({
      historyStageId: stageId,
      snapshotCursor: existing.length - 1,
      snapshotLength: existing.length,
    });
  },

  addSnapshot: async () => {
    const stageStore = useStageStore.getState();
    const stageId = stageStore.stage?.id;
    if (!stageId || get().historyStageId !== stageId) return;

    const existing = await snapshotsFor(stageId);
    if (useStageStore.getState().stage?.id !== stageId) return;
    const { snapshotCursor } = get();
    const deleteIds: number[] = [];

    if (snapshotCursor >= 0 && snapshotCursor < existing.length - 1) {
      for (const row of existing.slice(snapshotCursor + 1)) {
        if (row.id !== undefined) deleteIds.push(row.id);
      }
    }

    await db.snapshots.add({
      stageId,
      sessionId: existing[0]?.sessionId ?? stageId,
      index: stageStore.getSceneIndex(stageStore.currentSceneId || ''),
      slides: cloneScenes(stageStore.scenes),
    });

    let snapshotLength = existing.length - deleteIds.length + 1;
    if (snapshotLength > SNAPSHOT_LIMIT && existing[0]?.id !== undefined) {
      deleteIds.push(existing[0].id);
      snapshotLength -= 1;
    }

    const kept = existing.filter((row) => row.id === undefined || !deleteIds.includes(row.id));
    if (snapshotLength >= 2 && kept[snapshotLength - 2]?.id !== undefined) {
      await db.snapshots.update(kept[snapshotLength - 2].id as number, {
        index: stageStore.getSceneIndex(stageStore.currentSceneId || ''),
      });
    }

    if (deleteIds.length > 0) await db.snapshots.bulkDelete(deleteIds);

    if (useStageStore.getState().stage?.id !== stageId) return;
    set({
      historyStageId: stageId,
      snapshotCursor: snapshotLength - 1,
      snapshotLength,
    });
  },

  undo: async () => {
    const stageId = useStageStore.getState().stage?.id;
    const { snapshotCursor, historyStageId } = get();
    if (!stageId || historyStageId !== stageId || snapshotCursor <= 0) return;

    const snapshots = await snapshotsFor(stageId);
    if (useStageStore.getState().stage?.id !== stageId) return;
    const snapshot = snapshots[snapshotCursor - 1];
    if (!snapshot || !belongsToStage(snapshot, stageId)) return;

    const sceneIndex = Math.min(snapshot.index, Math.max(snapshot.slides.length - 1, 0));
    const stageStore = useStageStore.getState();
    if (stageStore.stage?.id !== stageId) return;
    stageStore.setScenes(snapshot.slides);
    if (snapshot.slides[sceneIndex]) {
      stageStore.setCurrentSceneId(snapshot.slides[sceneIndex].id);
    }
    set({ snapshotCursor: snapshotCursor - 1 });
  },

  redo: async () => {
    const stageId = useStageStore.getState().stage?.id;
    const { snapshotCursor, snapshotLength, historyStageId } = get();
    if (!stageId || historyStageId !== stageId || snapshotCursor >= snapshotLength - 1) return;

    const snapshots = await snapshotsFor(stageId);
    if (useStageStore.getState().stage?.id !== stageId) return;
    const snapshot = snapshots[snapshotCursor + 1];
    if (!snapshot || !belongsToStage(snapshot, stageId)) return;

    const sceneIndex = Math.min(snapshot.index, Math.max(snapshot.slides.length - 1, 0));
    const stageStore = useStageStore.getState();
    if (stageStore.stage?.id !== stageId) return;
    stageStore.setScenes(snapshot.slides);
    if (snapshot.slides[sceneIndex]) {
      stageStore.setCurrentSceneId(snapshot.slides[sceneIndex].id);
    }
    set({ snapshotCursor: snapshotCursor + 1 });
  },
}));
