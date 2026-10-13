// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SceneProvider, useSceneData } from '@/lib/contexts/scene-context';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useStageStore } from '@/lib/store/stage';
import { useSnapshotStore } from '@/lib/store/snapshot';
import { db } from '@/lib/utils/database';
import { loadStageData, saveStageData } from '@/lib/utils/stage-storage';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { defaultTheme } from '@/e2e/fixtures/test-data/scene-content';

// Real provider, hooks, stores and persistence. Only IndexedDB is the in-memory
// implementation; the browser companion uses the native database and editor.
function scene(id: string, stageId: string): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title: id,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    content: {
      type: 'slide',
      canvas: { id, viewportSize: 1000, viewportRatio: 0.5625, theme: defaultTheme, elements: [] },
    },
  };
}
function text(id = useStageStore.getState().currentSceneId) {
  return (useStageStore.getState().scenes.find((s) => s.id === id)!.content as SlideContent).canvas
    .id;
}
type Actions = ReturnType<typeof useHistorySnapshot> & {
  edit: (value: string) => Promise<void>;
  bodyOnly: (value: string) => void;
};
let current: Actions;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const updaters = vi.fn();
function Controls() {
  const { updateSceneData } = useSceneData<SlideContent>();
  const history = useHistorySnapshot();
  useLayoutEffect(() => {
    const bodyOnly = (value: string) =>
      updateSceneData((draft) => {
        updaters();
        draft.canvas.id = value;
      });
    current = {
      ...history,
      bodyOnly,
      edit: async (value: string) => {
        bodyOnly(value);
        await history.addHistorySnapshot();
      },
    };
  }, [updateSceneData, history]);
  return null;
}
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <SceneProvider>
        <Controls />
      </SceneProvider>,
    ),
  );
}
async function seed(stageId = 'A') {
  await saveStageData(stageId, {
    stage: { id: stageId, name: stageId, createdAt: 1, updatedAt: 1 },
    scenes: [scene(`${stageId}-0`, stageId), scene(`${stageId}-1`, stageId)],
    currentSceneId: `${stageId}-0`,
    chats: [],
  });
  await useStageStore.getState().loadFromStorage(stageId, true);
  await useSnapshotStore.getState().initSnapshotDatabase();
}
beforeEach(async () => {
  useStageStore.setState({ stage: null, scenes: [], chats: [], currentSceneId: null });
  useSnapshotStore.setState({ historyStageId: null, snapshotCursor: -1, snapshotLength: 0 });
  await db.delete();
  await db.open();
  updaters.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  await useStageStore.getState().saveToStorage();
  useStageStore.setState({ stage: null, scenes: [], chats: [], currentSceneId: null });
});

test('force reload rejects old scene and snapshot callbacks synchronously when lineage changes', async () => {
  await seed();
  await mount();
  const old = current!;
  const owner = useStageStore.getState().persistenceOwner;
  const snapshots = await db.snapshots.toArray();
  let revision = -1;
  let stale: Promise<void> | undefined;
  const unsubscribe = useStageStore.subscribe((state) => {
    if (state.persistenceOwner === owner) return;
    unsubscribe();
    revision = state.editRevision;
    // The real load publishes its new owner before React commits/unmounts the
    // old subtree. This same-stack listener invokes that exact captured closure.
    stale = old.edit('stale');
  });
  try {
    await act(async () => {
      await useStageStore.getState().loadFromStorage('A', true);
      await stale;
    });
  } finally {
    unsubscribe();
  }
  expect(revision).toBeGreaterThan(-1);
  expect.soft(updaters).not.toHaveBeenCalled();
  expect.soft(text()).toBe('A-0');
  expect.soft(useStageStore.getState().editRevision).toBe(revision);
  expect.soft(await db.snapshots.toArray()).toEqual(snapshots);
  expect.soft((await loadStageData('A'))!.scenes[0].content).toEqual(scene('A-0', 'A').content);
});

test('setStage and setScenes reject old callbacks even with distinct scene IDs', async () => {
  await seed();
  await mount();
  const old = current!;
  let revision = -1;
  await act(async () => {
    useStageStore.getState().setStage({ id: 'B', name: 'B', createdAt: 1, updatedAt: 1 });
    useStageStore.getState().setScenes([scene('B-0', 'B')]);
    revision = useStageStore.getState().editRevision;
    await old.edit('stale');
  });
  expect.soft(updaters).not.toHaveBeenCalled();
  expect.soft(text()).toBe('B-0');
  expect.soft(useStageStore.getState().editRevision).toBe(revision);
  expect.soft(await db.snapshots.where('stageId').equals('B').count()).toBe(0);
});

for (const direction of ['undo', 'redo'] as const) {
  test(`a captured ${direction} callback cannot move history after same-classroom reload`, async () => {
    await seed();
    await mount();
    await act(async () => current!.edit('edited'));
    if (direction === 'redo') await act(async () => current!.undo());
    const old = current!;
    const body = structuredClone(useStageStore.getState().scenes);
    const snapshots = await db.snapshots.toArray();
    const cursor = useSnapshotStore.getState().snapshotCursor;
    await act(async () => useStageStore.getState().loadFromStorage('A', true));
    const revision = useStageStore.getState().editRevision;
    await act(async () => old[direction]());
    expect.soft(useStageStore.getState().scenes).toEqual(body);
    expect.soft(useStageStore.getState().editRevision).toBe(revision);
    expect.soft(useSnapshotStore.getState().snapshotCursor).toBe(cursor);
    expect.soft(await db.snapshots.toArray()).toEqual(snapshots);
  });
}

test('same lineage remains editable through repeated callbacks and revision commits', async () => {
  await seed();
  await mount();
  const old = current!;
  const owner = useStageStore.getState().persistenceOwner;
  const revision = owner!.revision;
  await act(async () => {
    await old.edit('first');
    await old.edit('second');
  });
  expect(text()).toBe('second');
  expect(useStageStore.getState().persistenceOwner).toBe(owner);
  expect(owner!.revision).toBeGreaterThan(revision!);
  expect(await db.snapshots.where('stageId').equals('A').count()).toBe(3);
  await act(async () => current!.undo());
  expect(text()).toBe('first');
  await act(async () => current!.redo());
  expect(text()).toBe('second');
});

test('same-lineage scene switch preserves the old callback scene identity', async () => {
  await seed();
  await mount();
  const old = current!;
  await act(async () => {
    useStageStore.getState().setCurrentSceneId('A-1');
    await old.edit('old-scene');
  });
  expect(text('A-0')).toBe('old-scene');
  expect(text('A-1')).toBe('A-1');
  await act(async () => current!.edit('new-scene'));
  expect(text('A-0')).toBe('old-scene');
  expect(text('A-1')).toBe('new-scene');
});
