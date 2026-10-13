import { useCallback } from 'react';
import { useSnapshotStore } from '@/lib/store/snapshot';
import { useStageStore } from '@/lib/store/stage';

/**
 * Hook for managing history snapshots (undo/redo)
 *
 * Usage:
 * ```tsx
 * const { addHistorySnapshot, canUndo, canRedo, undo, redo } = useHistorySnapshot();
 *
 * // After making changes
 * await addHistorySnapshot();
 *
 * // Undo/Redo
 * if (canUndo) await undo();
 * if (canRedo) await redo();
 * ```
 */
export function useHistorySnapshot() {
  const stageId = useStageStore((state) => state.stage?.id);
  const persistenceOwner = useStageStore((state) => state.persistenceOwner);
  const addSnapshot = useSnapshotStore((state) => state.addSnapshot);
  const undo = useSnapshotStore((state) => state.undo);
  const redo = useSnapshotStore((state) => state.redo);
  const canUndo = useSnapshotStore((state) => state.canUndo);
  const canRedo = useSnapshotStore((state) => state.canRedo);

  /**
   * Add a snapshot to the history
   * Call this after any significant state change that should be undoable
   */
  const isCurrentOwner = useCallback(() => {
    const active = useStageStore.getState();
    return active.stage?.id === stageId && active.persistenceOwner === persistenceOwner;
  }, [stageId, persistenceOwner]);
  const addHistorySnapshot = useCallback(async () => {
    if (isCurrentOwner()) await addSnapshot();
  }, [addSnapshot, isCurrentOwner]);
  const undoOwned = useCallback(async () => {
    if (isCurrentOwner()) await undo();
  }, [undo, isCurrentOwner]);
  const redoOwned = useCallback(async () => {
    if (isCurrentOwner()) await redo();
  }, [redo, isCurrentOwner]);

  return {
    addHistorySnapshot,
    undo: undoOwned,
    redo: redoOwned,
    canUndo: canUndo(),
    canRedo: canRedo(),
  };
}
