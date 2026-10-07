import 'fake-indexeddb/auto';
import { beforeEach, expect, test, vi } from 'vitest';
import { createStageAPI } from '@/lib/api/stage-api';
import { useStageStore } from '@/lib/store/stage';
import { db } from '@/lib/utils/database';
import { loadStageData } from '@/lib/utils/stage-storage';

beforeEach(async () => {
  useStageStore.getState().clearStore();
  await db.delete();
  await db.open();
  useStageStore
    .getState()
    .setStage({ id: 'api-stage', name: 'API classroom', createdAt: 1, updatedAt: 1 });
  const api = createStageAPI(useStageStore);
  expect(api.scene.create({ type: 'slide', title: 'Before edit' }).success).toBe(true);
  await useStageStore.getState().saveToStorage();
});

test('Stage API edits autosave to their classroom on immediate navigation', async () => {
  const api = createStageAPI(useStageStore);
  const sceneId = useStageStore.getState().scenes[0].id;
  const revision = useStageStore.getState().editRevision;
  expect(api.scene.update(sceneId, { title: 'API edit' }).success).toBe(true);
  expect(useStageStore.getState().editRevision).toBeGreaterThan(revision);
  useStageStore
    .getState()
    .setStage({ id: 'another-stage', name: 'Another', createdAt: 1, updatedAt: 1 });
  await useStageStore.getState().saveToStorage();
  await vi.waitFor(async () =>
    expect((await loadStageData('api-stage'))?.scenes[0].title).toBe('API edit'),
  );
});

test('Stage API metadata edits preserve the classroom scenes, selection and chats', async () => {
  const api = createStageAPI(useStageStore);
  const before = useStageStore.getState();
  const revision = before.editRevision;
  expect(api.stage.update({ name: 'Renamed classroom' }).success).toBe(true);
  const after = useStageStore.getState();
  expect(after.stage?.name).toBe('Renamed classroom');
  expect(after.scenes).toBe(before.scenes);
  expect(after.currentSceneId).toBe(before.currentSceneId);
  expect(after.chats).toBe(before.chats);
  expect(after.editRevision).toBeGreaterThan(revision);
  await after.saveToStorage();
  const stored = await loadStageData('api-stage');
  expect(stored?.stage.name).toBe('Renamed classroom');
  expect(stored?.scenes).toHaveLength(1);
});

test('Stage API mutations invalidate a load that started before the edit', async () => {
  const api = createStageAPI(useStageStore);
  const sceneId = useStageStore.getState().scenes[0].id;
  useStageStore.setState({ scenes: [] });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = db.stages.get.bind(db.stages);
  const spy = vi.spyOn(db.stages, 'get').mockImplementation(((key: string) => {
    entered();
    return gate.then(() => original(key));
  }) as typeof db.stages.get);
  try {
    const pending = useStageStore.getState().loadFromStorage('api-stage');
    await started;
    expect(api.scene.create({ type: 'slide', title: 'Newer generated scene' }).success).toBe(true);
    const edited = useStageStore.getState().scenes;
    release();
    await pending;
    expect(useStageStore.getState().scenes).toBe(edited);
    expect(useStageStore.getState().scenes.some((scene) => scene.id === sceneId)).toBe(false);
    await useStageStore.getState().saveToStorage();
  } finally {
    release();
    spy.mockRestore();
  }
});
