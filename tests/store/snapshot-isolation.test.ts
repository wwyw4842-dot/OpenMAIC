import 'fake-indexeddb/auto';
import { defaultTheme } from '@/e2e/fixtures/test-data/scene-content';
import { afterEach, expect, test } from 'vitest';
import type { Scene, Stage } from '@/lib/types/stage';
import { db } from '@/lib/utils/database';
import { loadStageData, saveStageData } from '@/lib/utils/stage-storage';
import { useSnapshotStore } from '@/lib/store/snapshot';
import { useStageStore } from '@/lib/store/stage';

function scene(stageId: string, title: string): Scene {
  return {
    id: `${stageId}-scene`,
    stageId,
    type: 'slide',
    title,
    order: 0,
    content: { type: 'slide', canvas: { id: 'canvas', elements: [], viewportSize: 1000, viewportRatio: 0.5625, theme: defaultTheme } } as Scene['content'],
    createdAt: 1,
    updatedAt: 1,
  };
}

function classroom(id: string, title: string) {
  const stage: Stage = { id, name: id, createdAt: 1, updatedAt: 1 };
  return { stage, scenes: [scene(id, title)], currentSceneId: `${id}-scene`, chats: [] };
}

afterEach(async () => {
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null, chats: [] });
  useSnapshotStore.setState({ snapshotCursor: -1, snapshotLength: 0, historyStageId: null });
  await db.snapshots.clear();
  await db.stages.clear();
  await db.scenes.clear();
});

test('undo after switching classrooms restores only the active classroom', async () => {
  await saveStageData('A', classroom('A', 'A original'));
  useStageStore.setState(classroom('A', 'A original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('B', 'B original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('B', 'B edited'));
  await useSnapshotStore.getState().addSnapshot();
  expect(useSnapshotStore.getState().canUndo()).toBe(true);
  await useSnapshotStore.getState().undo();

  const now = useStageStore.getState();
  expect(now.stage?.id).toBe('B');
  expect(now.scenes.map((item) => item.stageId)).toEqual(['B']);
  expect(now.scenes.map((item) => item.title)).toEqual(['B original']);
  expect(useSnapshotStore.getState().canRedo()).toBe(true);

  await useStageStore.getState().saveToStorage();
  const savedB = await loadStageData('B');
  const savedA = await loadStageData('A');
  expect(savedB?.scenes.map((item) => `${item.stageId}:${item.title}`)).toEqual(['B:B original']);
  expect(savedA?.scenes.map((item) => item.title)).toEqual(['A original']);
});

test('repeating init does not append another baseline or reset the cursor', async () => {
  useStageStore.setState(classroom('A', 'A original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  await useSnapshotStore.getState().addSnapshot();
  const before = useSnapshotStore.getState().snapshotCursor;
  await useSnapshotStore.getState().initSnapshotDatabase();
  const rows = await db.snapshots.toArray();
  expect(rows).toHaveLength(2);
  expect(useSnapshotStore.getState().snapshotCursor).toBe(before);
  expect(useSnapshotStore.getState().canUndo()).toBe(true);
});

test('history stays capped at 20 entries for one classroom', async () => {
  useStageStore.setState(classroom('A', 'A 0'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  for (let i = 1; i <= 25; i += 1) {
    useStageStore.setState(classroom('A', `A ${i}`));
    await useSnapshotStore.getState().addSnapshot();
  }
  const rows = await db.snapshots.toArray();
  expect(rows.length).toBeLessThanOrEqual(20);
  expect(useSnapshotStore.getState().snapshotLength).toBe(rows.length);
  expect(useSnapshotStore.getState().snapshotCursor).toBe(rows.length - 1);
  expect(rows[rows.length - 1]?.slides[0]?.title).toBe('A 25');
});

test('a new edit after undo drops only this classroom redo tail', async () => {
  useStageStore.setState(classroom('A', 'A original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'A edited'));
  await useSnapshotStore.getState().addSnapshot();
  await useSnapshotStore.getState().undo();
  useStageStore.setState(classroom('A', 'A branched'));
  await useSnapshotStore.getState().addSnapshot();
  expect(useSnapshotStore.getState().snapshotLength).toBe(2);
  expect(useSnapshotStore.getState().canRedo()).toBe(false);
  const rows = await db.snapshots.toArray();
  expect(rows.map((row) => row.slides[0]?.title)).toEqual(['A original', 'A branched']);
});

test('undo does not apply after the active classroom changes', async () => {
  useStageStore.setState(classroom('A', 'A original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'A edited'));
  await useSnapshotStore.getState().addSnapshot();
  useStageStore.setState(classroom('B', 'B original'));
  await useSnapshotStore.getState().undo();
  expect(useStageStore.getState().scenes.map((item) => item.title)).toEqual(['B original']);
});
