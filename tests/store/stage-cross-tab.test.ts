import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { db } from '@/lib/utils/database';
import {
  loadStageData,
  saveStageData,
  renameStage,
  loadConflictDrafts,
} from '@/lib/utils/stage-storage';
import type { StageStoreData } from '@/lib/utils/stage-storage';
import { useStageStore } from '@/lib/store/stage';
import { useSnapshotStore } from '@/lib/store/snapshot';
import { defaultTheme } from '@/e2e/fixtures/test-data/scene-content';

function initial(): StageStoreData {
  return {
    stage: { id: 'shared', name: 'Original', createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: 'scene',
        stageId: 'shared',
        type: 'slide',
        title: 'Original',
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
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    currentSceneId: 'scene',
    chats: [],
    outlines: [],
  };
}
beforeEach(async () => {
  useStageStore.setState({ stage: null, scenes: [], persistenceOwner: null });
  useSnapshotStore.setState({ historyStageId: null, snapshotCursor: -1, snapshotLength: 0 });
  await db.delete();
  await db.open();
});

test('a stale tab cannot replace newer scenes with its metadata edit', async () => {
  await saveStageData('shared', initial());
  const a = (await loadStageData('shared'))!;
  const b = structuredClone(a);
  a.scenes[0].title = 'A new content';
  await saveStageData('shared', a);
  b.stage.name = 'B metadata edit';
  await expect(saveStageData('shared', b)).rejects.toThrow(/conflict/i);
  const durable = (await loadStageData('shared'))!;
  expect(durable.scenes[0].title).toBe('A new content');
  expect(durable.stage.name).toBe('Original');
});

test('duplicate requests based on the same version only commit once', async () => {
  await saveStageData('shared', initial());
  const request = (await loadStageData('shared'))!;
  request.scenes[0].title = 'once';
  const results = await Promise.allSettled([
    saveStageData('shared', structuredClone(request)),
    saveStageData('shared', structuredClone(request)),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('once');
});

test('legacy records without a revision still reject the second writer', async () => {
  const data = initial();
  await db.stages.put(data.stage);
  await db.scenes.bulkPut(data.scenes.map((scene) => ({ ...scene, createdAt: 1, updatedAt: 1 })));
  const a = (await loadStageData('shared'))!;
  const b = structuredClone(a);
  a.scenes[0].title = 'legacy A';
  await saveStageData('shared', a);
  b.scenes[0].title = 'legacy B';
  await expect(saveStageData('shared', b)).rejects.toThrow(/conflict/i);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('legacy A');
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Finish/cancel pending autosaves before removing this test's database.
  await useStageStore
    .getState()
    .saveToStorage()
    .catch(() => undefined);
  for (const draft of useStageStore.getState().conflictDrafts)
    await useStageStore
      .getState()
      .saveConflictCopy(draft.id)
      .catch(() => undefined);
  useStageStore.setState({ stage: null, scenes: [], persistenceOwner: null });
});

async function loadLocal() {
  await saveStageData('shared', initial());
  await useStageStore.getState().loadFromStorage('shared', true);
}
async function externalEdit(title = 'remote edit') {
  const remote = (await loadStageData('shared'))!;
  remote.scenes[0].title = title;
  await saveStageData('shared', remote);
}

function deferred() {
  let release!: () => void;
  let entered!: () => void;
  return {
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    release: () => release(),
    entered: () => entered(),
  };
}

test('one tab advances its baseline for queued consecutive edits', async () => {
  await loadLocal();
  const saves = [];
  for (const title of ['one', 'two', 'three']) {
    useStageStore.getState().updateScene('scene', { title });
    saves.push(useStageStore.getState().saveToStorage());
  }
  await Promise.all(saves);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('three');
  expect((await loadStageData('shared'))!.contentRevision).toBe(4);
  expect(useStageStore.getState().persistenceOwner!.revision).toBe(4);
});

test('a conflict retains the newest draft and ordinary retry cannot overwrite', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'my draft' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  useStageStore.getState().updateScene('scene', { title: 'newest draft' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  await useStageStore.getState().retryFailedSaves();
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('remote edit');
  expect(useStageStore.getState().scenes[0].title).toBe('newest draft');
  expect((await loadConflictDrafts()).at(-1)!.payload.scenes[0].title).toBe('newest draft');
});

test('read latest preserves a separate draft which can be copied with unique row IDs', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'my retained content' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  await useStageStore.getState().loadLatestForConflict(draft.id);
  expect(useStageStore.getState().scenes[0].title).toBe('remote edit');
  expect(
    (await loadConflictDrafts()).find((item) => item.id === draft.id)!.payload.scenes[0].title,
  ).toBe('my retained content');
  const copyId = await useStageStore.getState().saveConflictCopy(draft.id);
  const copied = (await loadStageData(copyId))!;
  expect(copied.scenes[0].title).toBe('my retained content');
  expect(copied.scenes[0].id).not.toBe('scene');
  expect(copied.scenes[0].stageId).toBe(copyId);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('remote edit');
  expect(useStageStore.getState().stage!.id).toBe('shared');
  expect(await loadConflictDrafts()).toEqual([]);
});

test('failed storage retry becomes a conflict if another tab committed meanwhile', async () => {
  await loadLocal();
  useStageStore.getState().updateScene('scene', { title: 'quota draft' });
  const fail = vi.spyOn(db.scenes, 'bulkPut').mockRejectedValueOnce(new Error('disk full'));
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow('disk full');
  fail.mockRestore();
  await externalEdit();
  await expect(useStageStore.getState().retryFailedSaves()).rejects.toThrow(/conflict/i);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('remote edit');
  expect((await loadConflictDrafts()).at(-1)!.payload.scenes[0].title).toBe('quota draft');
});

test('conflicted undo cannot mutate snapshots, cursor, or the visible draft', async () => {
  await loadLocal();
  await useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('scene', { title: 'local edit' });
  await useSnapshotStore.getState().addSnapshot();
  await externalEdit();
  const before = await db.snapshots.toArray();
  const record = await db.stages.get('shared');
  await expect(useSnapshotStore.getState().undo()).rejects.toThrow(/conflict/i);
  expect(await db.snapshots.toArray()).toEqual(before);
  expect(await db.stages.get('shared')).toEqual(record);
  expect(useStageStore.getState().scenes[0].title).toBe('local edit');
  expect(useSnapshotStore.getState().snapshotCursor).toBe(1);
});

test('late conflict results do not navigate back from another classroom', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'old classroom draft' });
  const gate = deferred();
  const storage = await import('@/lib/utils/stage-storage');
  const original = storage.saveStageData;
  const slow = vi.spyOn(storage, 'saveStageData').mockImplementationOnce(async (...args) => {
    gate.entered();
    await gate.gate;
    return original(...args);
  });
  const pending = useStageStore.getState().saveToStorage();
  await gate.started;
  useStageStore.getState().setStage({ id: 'another', name: 'Another', createdAt: 1, updatedAt: 1 });
  gate.release();
  await expect(pending).rejects.toThrow(/conflict/i);
  slow.mockRestore();
  await useStageStore.getState().saveToStorage();
  expect(useStageStore.getState().stage!.id).toBe('another');
  expect((await loadConflictDrafts()).at(-1)!.payload.scenes[0].title).toBe('old classroom draft');
});

test('renaming from the home page invalidates an already loaded body', async () => {
  await saveStageData('shared', initial());
  const stale = (await loadStageData('shared'))!;
  await renameStage('shared', 'new home name');
  await expect(saveStageData('shared', stale)).rejects.toThrow(/conflict/i);
  expect((await loadStageData('shared'))!.stage.name).toBe('new home name');
});

test('a deleted existing classroom cannot be resurrected by its old tab', async () => {
  await saveStageData('shared', initial());
  const stale = (await loadStageData('shared'))!;
  await db.stages.delete('shared');
  await expect(saveStageData('shared', stale)).rejects.toThrow(/conflict/i);
  expect(await db.stages.get('shared')).toBeUndefined();
});

test('conflict checks precede every history mutation', async () => {
  await saveStageData('shared', initial());
  const stale = (await loadStageData('shared'))!;
  await externalEdit();
  const history = vi.fn(async () => {
    await db.snapshots.clear();
  });
  await expect(saveStageData('shared', stale, history)).rejects.toThrow(/conflict/i);
  expect(history).not.toHaveBeenCalled();
});

test('aborted writes preserve their revision and can retry the same version', async () => {
  await saveStageData('shared', initial());
  const request = (await loadStageData('shared'))!;
  request.scenes[0].title = 'retry edit';
  const fail = vi.spyOn(db.scenes, 'bulkPut').mockRejectedValueOnce(new Error('abort'));
  await expect(saveStageData('shared', request)).rejects.toThrow('abort');
  fail.mockRestore();
  expect((await loadStageData('shared'))!.contentRevision).toBe(request.contentRevision);
  await saveStageData('shared', request);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('retry edit');
});

test('new history initialization and queued body writes share one client baseline', async () => {
  useStageStore.getState().setStage(initial().stage);
  useStageStore.getState().setScenes(initial().scenes);
  const history = useSnapshotStore.getState().initSnapshotDatabase();
  useStageStore.getState().updateScene('scene', { title: 'after init' });
  const body = useStageStore.getState().saveToStorage();
  await Promise.all([history, body]);
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('after init');
  expect(useStageStore.getState().persistenceOwner!.revision).toBe(
    (await loadStageData('shared'))!.contentRevision,
  );
});

test('copy captures edits made after conflict before debounce and keeps later edits', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'first draft' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  useStageStore.getState().updateScene('scene', { title: 'latest before click' });
  const storage = await import('@/lib/utils/stage-storage');
  const gate = deferred();
  const original = storage.saveStageCopy;
  const slow = vi.spyOn(storage, 'saveStageCopy').mockImplementationOnce(async (...args) => {
    gate.entered();
    await gate.gate;
    return original(...args);
  });
  const copying = useStageStore.getState().saveConflictCopy(draft.id);
  await gate.started;
  useStageStore.getState().updateScene('scene', { title: 'new edit during copy' });
  gate.release();
  const id = await copying;
  slow.mockRestore();
  expect((await loadStageData(id))!.scenes[0].title).toBe('latest before click');
  expect(useStageStore.getState().scenes[0].title).toBe('new edit during copy');
  expect((await loadConflictDrafts()).find((d) => d.id === draft.id)!.payload.scenes[0].title).toBe(
    'new edit during copy',
  );
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('remote edit');
});

test('a new edit during read-latest backup cancels the load and remains recoverable', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'before read' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  const storage = await import('@/lib/utils/stage-storage');
  const gate = deferred();
  const original = storage.retainConflictDraft;
  const slow = vi.spyOn(storage, 'retainConflictDraft').mockImplementationOnce(async (...args) => {
    gate.entered();
    await gate.gate;
    return original(...args);
  });
  const reading = useStageStore.getState().loadLatestForConflict(draft.id);
  await gate.started;
  useStageStore.getState().updateScene('scene', { title: 'newer during backup' });
  gate.release();
  await reading;
  slow.mockRestore();
  expect(useStageStore.getState().scenes[0].title).toBe('newer during backup');
  expect((await loadConflictDrafts()).find((d) => d.id === draft.id)!.payload.scenes[0].title).toBe(
    'newer during backup',
  );
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('remote edit');
});

test('read-latest backup completion cannot replace a newer conflicted autosave', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'first draft' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  const storage = await import('@/lib/utils/stage-storage');
  const first = deferred();
  const second = deferred();
  const original = storage.retainConflictDraft;
  const slow = vi
    .spyOn(storage, 'retainConflictDraft')
    .mockImplementationOnce(async (...args) => {
      first.entered();
      await first.gate;
      return original(...args);
    })
    .mockImplementationOnce(async (...args) => {
      second.entered();
      await second.gate;
      return original(...args);
    });
  const reading = useStageStore.getState().loadLatestForConflict(draft.id);
  await first.started;
  useStageStore.getState().updateScene('scene', { title: 'second draft' });
  first.release();
  await second.started;
  useStageStore.getState().updateScene('scene', { title: 'third draft' });
  const saving = useStageStore.getState().saveToStorage();
  const rejection = expect(saving).rejects.toThrow(/conflict/i);
  await new Promise((resolve) => setTimeout(resolve, 0));
  second.release();
  await reading;
  await rejection;
  slow.mockRestore();
  expect(useStageStore.getState().scenes[0].title).toBe('third draft');
  expect((await loadConflictDrafts()).find((d) => d.id === draft.id)!.payload.scenes[0].title).toBe(
    'third draft',
  );
});

test('copying an older retained draft flushes newer-owner edits after read-latest', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'old draft' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  await useStageStore.getState().loadLatestForConflict(draft.id);
  useStageStore.getState().updateScene('scene', { title: 'new owner edit' });
  const id = await useStageStore.getState().saveConflictCopy(draft.id);
  expect((await loadStageData(id))!.scenes[0].title).toBe('old draft');
  expect((await loadStageData('shared'))!.scenes[0].title).toBe('new owner edit');
  expect(useStageStore.getState().scenes[0].title).toBe('new owner edit');
});

test('a conflicted autosave during copy cleanup keeps the newer recovery draft', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'retained draft' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  const storage = await import('@/lib/utils/stage-storage');
  const gate = deferred();
  const original = storage.deleteConflictDraft;
  const slow = vi.spyOn(storage, 'deleteConflictDraft').mockImplementationOnce(async (...args) => {
    gate.entered();
    await gate.gate;
    return original(...args);
  });
  const copying = useStageStore.getState().saveConflictCopy(draft.id);
  await gate.started;
  useStageStore.getState().updateScene('scene', { title: 'new conflicted edit' });
  const retry = useStageStore.getState().saveToStorage();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate.release();
  await copying;
  await expect(retry).rejects.toThrow(/conflict/i);
  slow.mockRestore();
  expect((await loadConflictDrafts()).find((d) => d.id === draft.id)!.payload.scenes[0].title).toBe(
    'new conflicted edit',
  );
});

test('copy preserves local media bytes and clones generated agents after source deletion', async () => {
  await loadLocal();
  await db.generatedAgents.put({
    id: 'gen-profile',
    stageId: 'shared',
    name: 'Teacher',
    role: 'teacher',
    persona: '',
    avatar: '',
    color: '',
    priority: 1,
    createdAt: 1,
  });
  await db.mediaFiles.put({
    id: 'shared:gen_img_1',
    stageId: 'shared',
    type: 'image',
    blob: new Blob([new Uint8Array([7, 8, 9])]),
    mimeType: 'image/png',
    size: 3,
    prompt: '',
    params: '',
    createdAt: 1,
  });
  await externalEdit();
  useStageStore
    .getState()
    .updateStage({ ...useStageStore.getState().stage!, agentIds: ['gen-profile'] });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  const draft = useStageStore.getState().conflictDrafts.at(-1)!;
  const id = await useStageStore.getState().saveConflictCopy(draft.id);
  const copy = (await loadStageData(id))!;
  const copyMedia = await db.mediaFiles.get(`${id}:gen_img_1`);
  expect([...new Uint8Array(await copyMedia!.blob.arrayBuffer())]).toEqual([7, 8, 9]);
  expect(copy.stage.agentIds![0]).not.toBe('gen-profile');
  expect((await db.generatedAgents.get(copy.stage.agentIds![0]))!.stageId).toBe(id);
  await db.mediaFiles.where('stageId').equals('shared').delete();
  await db.generatedAgents.where('stageId').equals('shared').delete();
  expect((await db.mediaFiles.get(`${id}:gen_img_1`))!.blob.size).toBe(3);
  expect(await db.generatedAgents.get(copy.stage.agentIds![0])).toBeDefined();
  const { loadGeneratedAgentsForStage } = await import('@/lib/orchestration/registry/store');
  expect(await loadGeneratedAgentsForStage(id)).toEqual(copy.stage.agentIds);
});

// Restart creates fresh store/DB modules against the same persisted recovery row.
test('conflict drafts survive a new module instance and remain copyable', async () => {
  await loadLocal();
  await externalEdit();
  useStageStore.getState().updateScene('scene', { title: 'survives restart' });
  await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/conflict/i);
  db.close();
  vi.resetModules();
  const { db: freshDb } = await import('@/lib/utils/database');
  const { useStageStore: fresh } = await import('@/lib/store/stage');
  const { loadStageData: freshLoad } = await import('@/lib/utils/stage-storage');
  try {
    await fresh.getState().loadFromStorage('shared');
    expect(fresh.getState().scenes[0].title).toBe('remote edit');
    const draft = fresh.getState().conflictDrafts.at(-1)!;
    const id = await fresh.getState().saveConflictCopy(draft.id);
    expect((await freshLoad(id))!.scenes[0].title).toBe('survives restart');
    expect((await freshLoad('shared'))!.scenes[0].title).toBe('remote edit');
  } finally {
    freshDb.close();
    await db.open();
  }
});
