import 'fake-indexeddb/auto';
import { defaultTheme } from '@/e2e/fixtures/test-data/scene-content';
import { afterEach, expect, test, vi } from 'vitest';
import Dexie from 'dexie';
import type { Scene, Stage } from '@/lib/types/stage';
import { db, exportLegacySnapshots } from '@/lib/utils/database';
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
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas',
        elements: [],
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: defaultTheme,
      },
    } as Scene['content'],
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

test('concurrent snapshot appends keep each captured edit in order', async () => {
  useStageStore.setState(classroom('A', 'A 0'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  const saves = [];
  for (let i = 1; i <= 8; i += 1) {
    useStageStore.setState(classroom('A', `A ${i}`));
    saves.push(useSnapshotStore.getState().addSnapshot());
  }
  await Promise.all(saves);
  expect((await db.snapshots.toArray()).map((row) => row.slides[0].title)).toEqual(
    Array.from({ length: 9 }, (_, i) => `A ${i}`),
  );
  expect(useSnapshotStore.getState().snapshotLength).toBe(9);
  await Promise.all([useSnapshotStore.getState().undo(), useSnapshotStore.getState().undo()]);
  expect(useStageStore.getState().scenes[0].title).toBe('A 6');
});

test('snapshot failure rolls back redo deletion and preserves the cursor', async () => {
  useStageStore.setState(classroom('A', 'A original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'A edited'));
  await useSnapshotStore.getState().addSnapshot();
  await useSnapshotStore.getState().undo();
  const before = await db.snapshots.toArray();
  const cursor = useSnapshotStore.getState().snapshotCursor;
  const spy = vi
    .spyOn(db.snapshots, 'add')
    .mockRejectedValueOnce(new DOMException('No space', 'QuotaExceededError'));
  useStageStore.setState(classroom('A', 'A failed branch'));
  try {
    await expect(useSnapshotStore.getState().addSnapshot()).rejects.toThrow('No space');
  } finally {
    spy.mockRestore();
  }
  expect(await db.snapshots.toArray()).toEqual(before);
  expect(useSnapshotStore.getState().snapshotCursor).toBe(cursor);
  await useSnapshotStore.getState().redo();
  expect(useStageStore.getState().scenes[0].title).toBe('A edited');
});

test('an edit while undo is reading cancels the late restore', async () => {
  useStageStore.setState(classroom('A', 'A original'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'A edited'));
  await useSnapshotStore.getState().addSnapshot();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = db.snapshots.where.bind(db.snapshots);
  const spy = vi.spyOn(db.snapshots, 'where').mockImplementation(((index: string) => {
    const clause = original(index);
    const equals = clause.equals.bind(clause);
    clause.equals = (key) => {
      const collection = equals(key);
      const sortBy = collection.sortBy.bind(collection);
      collection.sortBy = ((field: string) => {
        entered();
        return gate.then(() => sortBy(field));
      }) as typeof collection.sortBy;
      return collection;
    };
    return clause;
  }) as typeof db.snapshots.where);
  try {
    const pending = useSnapshotStore.getState().undo();
    await started;
    useStageStore.getState().updateScene('A-scene', { title: 'newer edit' });
    release();
    await pending;
    expect(useStageStore.getState().scenes[0].title).toBe('newer edit');
    expect(useSnapshotStore.getState().snapshotCursor).toBe(1);
    await useStageStore.getState().saveToStorage();
  } finally {
    release();
    spy.mockRestore();
  }
});

test('v10 unowned history survives upgrade and is explicitly exportable', async () => {
  await db.delete();
  const legacy = new Dexie(db.name);
  legacy.version(10).stores({ snapshots: '++id' });
  await legacy.open();
  const original = { id: 83, index: 0, slides: [scene('legacy', 'irreplaceable old body')] };
  await legacy.table('snapshots').add(original);
  legacy.close();
  await db.open();
  expect(await exportLegacySnapshots()).toEqual([original]);
  useStageStore.setState(classroom('A', 'A fresh'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  expect(useSnapshotStore.getState().canUndo()).toBe(false);
  expect(await exportLegacySnapshots()).toEqual([original]);
});

test('an initialization queued before the first edit keeps its original baseline', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  const initializing = useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('A-scene', { title: 'one' });
  const appending = useSnapshotStore.getState().addSnapshot();
  await Promise.all([initializing, appending]);
  await useSnapshotStore.getState().undo();
  expect(useStageStore.getState().scenes[0].title).toBe('zero');
  expect((await loadStageData('A'))?.scenes[0].title).toBe('zero');
  expect((await db.stages.get('A'))?.snapshotCursor).toBe(0);
});

test('old stage metadata infers the saved undo position instead of the redo tail', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  for (const title of ['one', 'two']) {
    useStageStore.setState(classroom('A', title));
    await useSnapshotStore.getState().addSnapshot();
  }
  await useSnapshotStore.getState().undo();
  const record = (await db.stages.get('A'))!;
  const { snapshotCursor: _cursor, snapshotSessionId: _session, ...legacy } = record;
  await db.stages.put(legacy);
  useSnapshotStore.setState({ historyStageId: null, snapshotCursor: -1, snapshotLength: 0 });
  await useSnapshotStore.getState().initSnapshotDatabase();
  expect(useSnapshotStore.getState().snapshotCursor).toBe(1);
  useStageStore.getState().updateScene('A-scene', { title: 'branch' });
  await useSnapshotStore.getState().addSnapshot();
  await useSnapshotStore.getState().undo();
  expect(useStageStore.getState().scenes[0].title).toBe('one');
  expect((await db.snapshots.toArray()).map((row) => row.slides[0].title)).toEqual([
    'zero',
    'one',
    'branch',
  ]);
});

test('unmatched older history survives while the saved content starts a safe session', async () => {
  useStageStore.setState(classroom('A', 'old zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'old two'));
  await useSnapshotStore.getState().addSnapshot();
  const oldRows = await db.snapshots.toArray();
  const record = (await db.stages.get('A'))!;
  const { snapshotCursor: _cursor, snapshotSessionId: _session, ...legacy } = record;
  await db.stages.put(legacy);
  await saveStageData('A', classroom('A', 'unmatched saved content'));
  useStageStore.setState(classroom('A', 'unmatched saved content'));
  useSnapshotStore.setState({ historyStageId: null, snapshotCursor: -1, snapshotLength: 0 });
  await useSnapshotStore.getState().initSnapshotDatabase();
  expect(useSnapshotStore.getState().canUndo()).toBe(false);
  expect(useSnapshotStore.getState().snapshotLength).toBe(1);
  expect((await db.snapshots.toArray()).slice(0, oldRows.length)).toEqual(oldRows);
  useStageStore.getState().updateScene('A-scene', { title: 'safe branch' });
  await useSnapshotStore.getState().addSnapshot();
  await useSnapshotStore.getState().undo();
  expect(useStageStore.getState().scenes[0].title).toBe('unmatched saved content');
  expect((await db.snapshots.toArray()).slice(0, oldRows.length)).toEqual(oldRows);
});

test('undo scene write failure preserves both durable and visible content and cursor', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'one'));
  await useSnapshotStore.getState().addSnapshot();
  const before = await db.stages.get('A');
  const spy = vi
    .spyOn(db.scenes, 'bulkPut')
    .mockRejectedValueOnce(new DOMException('Undo disk full', 'QuotaExceededError'));
  try {
    await expect(useSnapshotStore.getState().undo()).rejects.toThrow('Undo disk full');
  } finally {
    spy.mockRestore();
  }
  expect(useStageStore.getState().scenes[0].title).toBe('one');
  expect(useSnapshotStore.getState().snapshotCursor).toBe(1);
  expect(await db.stages.get('A')).toEqual(before);
  expect((await loadStageData('A'))?.scenes[0].title).toBe('one');
  await useSnapshotStore.getState().undo();
  expect(useStageStore.getState().scenes[0].title).toBe('zero');
  expect((await db.stages.get('A'))?.snapshotCursor).toBe(0);
});

test('metadata failure after appending a snapshot rolls back all history mutations', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.setState(classroom('A', 'one'));
  await useSnapshotStore.getState().addSnapshot();
  await useSnapshotStore.getState().undo();
  const rows = await db.snapshots.toArray();
  const record = await db.stages.get('A');
  const spy = vi
    .spyOn(db.stages, 'put')
    .mockRejectedValueOnce(new DOMException('Metadata disk full', 'QuotaExceededError'));
  useStageStore.setState(classroom('A', 'failed branch'));
  try {
    await expect(useSnapshotStore.getState().addSnapshot()).rejects.toThrow('Metadata disk full');
  } finally {
    spy.mockRestore();
  }
  expect(await db.snapshots.toArray()).toEqual(rows);
  expect(await db.stages.get('A')).toEqual(record);
  expect((await loadStageData('A'))?.scenes[0].title).toBe('zero');
  expect(useSnapshotStore.getState().snapshotCursor).toBe(0);
  expect(useSnapshotStore.getState().canRedo()).toBe(true);
  await useSnapshotStore.getState().redo();
  expect(useStageStore.getState().scenes[0].title).toBe('one');
});

test('initialization cannot overwrite an explicitly saved newer edit', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useStageStore.getState().saveToStorage();
  const initializing = useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('A-scene', { title: 'newer saved edit' });
  const saving = useStageStore.getState().saveToStorage();
  await Promise.all([initializing, saving]);
  expect((await loadStageData('A'))?.scenes[0].title).toBe('newer saved edit');
  expect((await db.snapshots.toArray())[0].slides[0].title).toBe('zero');
});

test('initialization leaves a newer pending autosave available', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  const initializing = useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('A-scene', { title: 'newer pending edit' });
  await initializing;
  await vi.waitFor(async () => {
    expect((await loadStageData('A'))?.scenes[0].title).toBe('newer pending edit');
  });
  expect((await db.snapshots.toArray())[0].slides[0].title).toBe('zero');
});

test('failed history append can retry its body and undo point together', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('A-scene', { title: 'one' });
  const spy = vi.spyOn(db.stages, 'put').mockRejectedValueOnce(new Error('append quota'));
  try {
    await expect(useSnapshotStore.getState().addSnapshot()).rejects.toThrow('append quota');
  } finally {
    spy.mockRestore();
  }
  expect(useStageStore.getState().failedSaveStageIds).toContain('A');
  expect((await loadStageData('A'))?.scenes[0].title).toBe('zero');
  await useStageStore.getState().retryFailedSaves();
  expect(useStageStore.getState().failedSaveStageIds).not.toContain('A');
  expect((await loadStageData('A'))?.scenes[0].title).toBe('one');
  expect(useSnapshotStore.getState().snapshotCursor).toBe(1);
  expect((await db.snapshots.toArray()).map((row) => row.slides[0].title)).toEqual(['zero', 'one']);
  await useSnapshotStore.getState().undo();
  expect(useStageStore.getState().scenes[0].title).toBe('zero');
});

test('failed undo retries publish only after the durable cursor and body commit', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('A-scene', { title: 'one' });
  await useSnapshotStore.getState().addSnapshot();
  const spy = vi.spyOn(db.scenes, 'bulkPut').mockRejectedValueOnce(new Error('undo quota'));
  try {
    await expect(useSnapshotStore.getState().undo()).rejects.toThrow('undo quota');
  } finally {
    spy.mockRestore();
  }
  expect(useStageStore.getState().failedSaveStageIds).toContain('A');
  expect(useStageStore.getState().scenes[0].title).toBe('one');
  await useStageStore.getState().retryFailedSaves();
  expect(useStageStore.getState().failedSaveStageIds).not.toContain('A');
  expect(useStageStore.getState().scenes[0].title).toBe('zero');
  expect((await loadStageData('A'))?.scenes[0].title).toBe('zero');
  expect(useSnapshotStore.getState().snapshotCursor).toBe(0);
});

test('an older queued snapshot cannot overwrite a newer explicit save', async () => {
  useStageStore.setState(classroom('A', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('A-scene', { title: 'snapshot edit' });
  const appending = useSnapshotStore.getState().addSnapshot();
  useStageStore.getState().updateScene('A-scene', { title: 'newer saved edit' });
  const saving = useStageStore.getState().saveToStorage();
  await Promise.all([appending, saving]);
  expect((await loadStageData('A'))?.scenes[0].title).toBe('newer saved edit');
  expect((await db.snapshots.toArray()).map((row) => row.slides[0].title)).toEqual([
    'zero',
    'snapshot edit',
  ]);
});

// Keep the real module restart last: it intentionally discards the process-local stores.
test('module restart after undo and explicit save branches from the durable cursor', async () => {
  useStageStore.setState(classroom('reload-history', 'zero'));
  await useSnapshotStore.getState().initSnapshotDatabase();
  for (const title of ['one', 'two']) {
    useStageStore.setState(classroom('reload-history', title));
    await useSnapshotStore.getState().addSnapshot();
  }
  await useSnapshotStore.getState().undo();
  await useStageStore.getState().saveToStorage();
  expect((await db.stages.get('reload-history'))?.snapshotCursor).toBe(1);
  db.close();
  vi.resetModules();
  const { db: freshDb } = await import('@/lib/utils/database');
  const { useStageStore: freshStage } = await import('@/lib/store/stage');
  const { useSnapshotStore: freshHistory } = await import('@/lib/store/snapshot');
  try {
    await freshStage.getState().loadFromStorage('reload-history');
    expect(freshStage.getState().scenes[0].title).toBe('one');
    await freshHistory.getState().initSnapshotDatabase();
    expect(freshHistory.getState().snapshotCursor).toBe(1);
    expect(freshHistory.getState().canRedo()).toBe(true);
    freshStage.getState().updateScene('reload-history-scene', { title: 'branch' });
    await freshHistory.getState().addSnapshot();
    expect(freshHistory.getState().canRedo()).toBe(false);
    expect((await freshDb.snapshots.toArray()).map((row) => row.slides[0].title)).toEqual([
      'zero',
      'one',
      'branch',
    ]);
    await freshHistory.getState().undo();
    expect(freshStage.getState().scenes[0].title).toBe('one');
    expect((await freshDb.scenes.toArray())[0].title).toBe('one');
    expect((await freshDb.stages.get('reload-history'))?.snapshotCursor).toBe(1);
  } finally {
    freshDb.close();
    await db.open();
  }
});
