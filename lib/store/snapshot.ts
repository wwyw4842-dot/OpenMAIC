import { create } from 'zustand';
import { db, type Snapshot } from '@/lib/utils/database';
import { useStageStore } from './stage';
import type { Scene } from '@/lib/types/stage';

const SNAPSHOT_LIMIT = 20;
const cursors = new Map<string, number>();
let historyTail: Promise<void> = Promise.resolve();
function enqueueHistory(job: () => Promise<void>): Promise<void> {
  const current = historyTail.then(job);
  historyTail = current.catch(() => undefined);
  return current;
}
function cloneScenes(scenes: Scene[]): Scene[] {
  return structuredClone(scenes);
}
async function snapshotsFor(stageId: string): Promise<Snapshot[]> {
  return db.snapshots.where('stageId').equals(stageId).sortBy('id');
}
function active(stageId: string, revision: number) {
  const state = useStageStore.getState();
  return state.stage?.id === stageId && state.editRevision === revision;
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
    const stageId = request.stage?.id;
    if (!stageId) return Promise.resolve();
    return enqueueHistory(async () => {
      if (!active(stageId, request.editRevision) || get().historyStageId !== stageId) return;
      const rows = await snapshotsFor(stageId);
      if (!active(stageId, request.editRevision)) return;
      const cursor = (cursors.get(stageId) ?? get().snapshotCursor) + delta;
      const snapshot = rows[cursor];
      if (!snapshot || snapshot.slides.some((scene) => scene.stageId && scene.stageId !== stageId))
        return;
      const sceneIndex = Math.max(0, Math.min(snapshot.index, snapshot.slides.length - 1));
      // History navigation is serialized separately from edits. Do not increment
      // editRevision here: queued consecutive undo commands must remain ordered.
      useStageStore.setState({
        scenes: cloneScenes(snapshot.slides),
        currentSceneId: snapshot.slides[sceneIndex]?.id ?? null,
      });
      cursors.set(stageId, cursor);
      set({ snapshotCursor: cursor, snapshotLength: rows.length });
      await useStageStore.getState().saveToStorage();
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
    setSnapshotCursor: (cursor) => {
      const id = get().historyStageId;
      if (id) cursors.set(id, cursor);
      set({ snapshotCursor: cursor });
    },
    setSnapshotLength: (snapshotLength) => set({ snapshotLength }),
    initSnapshotDatabase: () => {
      const request = useStageStore.getState();
      const stageId = request.stage?.id;
      if (!stageId) return Promise.resolve();
      const slides = cloneScenes(request.scenes);
      return enqueueHistory(async () => {
        let rows: Snapshot[] = [];
        await db.transaction('rw', db.snapshots, async () => {
          rows = await snapshotsFor(stageId);
          if (!rows.length) {
            const first = {
              stageId,
              sessionId: stageId,
              index: request.getSceneIndex(request.currentSceneId || ''),
              slides,
            };
            const id = await db.snapshots.add(first);
            rows = [{ ...first, id }];
            cursors.set(stageId, 0);
          }
        });
        if (!active(stageId, request.editRevision)) return;
        const cursor = Math.min(cursors.get(stageId) ?? rows.length - 1, rows.length - 1);
        cursors.set(stageId, cursor);
        set({ historyStageId: stageId, snapshotCursor: cursor, snapshotLength: rows.length });
      });
    },
    addSnapshot: () => {
      const request = useStageStore.getState();
      const stageId = request.stage?.id;
      if (!stageId) return Promise.resolve();
      const slides = cloneScenes(request.scenes);
      const index = request.getSceneIndex(request.currentSceneId || '');
      return enqueueHistory(async () => {
        let length = 0;
        await db.transaction('rw', db.snapshots, async () => {
          const rows = await snapshotsFor(stageId);
          const cursor = Math.min(cursors.get(stageId) ?? rows.length - 1, rows.length - 1);
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
          await db.snapshots.add({
            stageId,
            sessionId: rows[0]?.sessionId ?? stageId,
            index,
            slides,
          });
          length = kept.length + 1;
        });
        cursors.set(stageId, length - 1);
        if (useStageStore.getState().stage?.id === stageId)
          set({ historyStageId: stageId, snapshotCursor: length - 1, snapshotLength: length });
      });
    },
    undo: () => move(-1),
    redo: () => move(1),
  };
});
