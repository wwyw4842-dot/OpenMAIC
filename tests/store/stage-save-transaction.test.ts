import 'fake-indexeddb/auto';
import { defaultTheme } from '@/e2e/fixtures/test-data/scene-content';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';
import { db } from '@/lib/utils/database';
import { loadStageData, saveStageData } from '@/lib/utils/stage-storage';
import * as storage from '@/lib/utils/stage-storage';
import { useStageStore } from '@/lib/store/stage';

const STAGE_ID = 'failure';

function stage(name: string): Stage {
  return { id: STAGE_ID, name, createdAt: 1, updatedAt: 1 };
}

function scene(title: string): Scene {
  return {
    id: 'scene-1',
    stageId: STAGE_ID,
    type: 'slide',
    title,
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
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

function chat(title: string): ChatSession {
  return {
    id: 'chat-1',
    type: 'qa',
    title,
    status: 'idle',
    messages: [],
    config: { agentIds: [], maxTurns: 1, currentTurn: 0 },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function seed() {
  await saveStageData(STAGE_ID, {
    stage: stage('Existing'),
    scenes: [scene('Existing saved content')],
    currentSceneId: 'scene-1',
    chats: [chat('Existing chat')],
  });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  useStageStore.setState({
    stage: null,
    scenes: [],
    currentSceneId: null,
    chats: [],
  });
});

test('real indexeddb save and reload keeps the scene', async () => {
  await saveStageData(STAGE_ID, {
    stage: stage('Normal'),
    scenes: [scene('Normal')],
    currentSceneId: 'scene-1',
    chats: [],
  });
  const loaded = await loadStageData(STAGE_ID);
  expect(loaded?.scenes[0]?.title).toBe('Normal');
  expect(loaded?.stage.name).toBe('Normal');
});

test('scene write failure rolls back the previous classroom', async () => {
  await seed();
  const original = db.scenes.bulkPut.bind(db.scenes);
  db.scenes.bulkPut = (async () => {
    throw new DOMException('Synthetic audit quota failure', 'QuotaExceededError');
  }) as unknown as typeof db.scenes.bulkPut;
  try {
    await expect(
      saveStageData(STAGE_ID, {
        stage: stage('Replacement'),
        scenes: [scene('Replacement')],
        currentSceneId: 'scene-1',
        chats: [chat('Replacement chat')],
      }),
    ).rejects.toThrow(/quota/i);
  } finally {
    db.scenes.bulkPut = original;
  }
  const loaded = await loadStageData(STAGE_ID);
  expect(loaded?.stage.name).toBe('Existing');
  expect(loaded?.scenes.map((item) => item.title)).toEqual(['Existing saved content']);
  expect(loaded?.chats.map((item) => item.title)).toEqual(['Existing chat']);
});

test('chat write failure rolls back the previous classroom', async () => {
  await seed();
  const original = db.chatSessions.bulkPut.bind(db.chatSessions);
  db.chatSessions.bulkPut = (async () => {
    throw new DOMException('Synthetic audit quota failure', 'QuotaExceededError');
  }) as unknown as typeof db.chatSessions.bulkPut;
  try {
    await expect(
      saveStageData(STAGE_ID, {
        stage: stage('Replacement'),
        scenes: [scene('Replacement')],
        currentSceneId: 'scene-1',
        chats: [chat('Replacement chat')],
      }),
    ).rejects.toThrow(/quota/i);
  } finally {
    db.chatSessions.bulkPut = original;
  }
  const loaded = await loadStageData(STAGE_ID);
  expect(loaded?.scenes.map((item) => item.title)).toEqual(['Existing saved content']);
  expect(loaded?.chats.map((item) => item.title)).toEqual(['Existing chat']);
});

test('saveToStorage rejects and leaves memory and the previous classroom intact', async () => {
  await seed();
  useStageStore.setState({
    stage: stage('Replacement'),
    scenes: [scene('Replacement')],
    currentSceneId: 'scene-1',
    chats: [chat('Replacement chat')],
  });
  const original = db.scenes.bulkPut.bind(db.scenes);
  db.scenes.bulkPut = (async () => {
    throw new DOMException('Synthetic audit quota failure', 'QuotaExceededError');
  }) as unknown as typeof db.scenes.bulkPut;
  try {
    await expect(useStageStore.getState().saveToStorage()).rejects.toThrow(/quota/i);
  } finally {
    db.scenes.bulkPut = original;
  }
  expect(useStageStore.getState().scenes.map((item) => item.title)).toEqual(['Replacement']);
  const loaded = await loadStageData(STAGE_ID);
  expect(loaded?.scenes.map((item) => item.title)).toEqual(['Existing saved content']);
});

for (const delay of [0, 100, 499]) {
  test(`autosave preserves edits when switching after ${delay}ms`, async () => {
    useStageStore.getState().setStage(stage('A'));
    useStageStore.getState().setScenes([scene('A before switch')]);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    useStageStore.getState().setStage({ ...stage('B'), id: 'B' });
    useStageStore.getState().setScenes([{ ...scene('B content'), id: 'B-scene', stageId: 'B' }]);
    await useStageStore.getState().saveToStorage();
    await vi.waitFor(async () =>
      expect((await loadStageData(STAGE_ID))?.scenes[0]?.title).toBe('A before switch'),
    );
    expect((await loadStageData('B'))?.scenes[0]?.title).toBe('B content');
  });
}

test('out-of-order classroom loads do not replace the latest navigation', async () => {
  await seed();
  await saveStageData('B', {
    stage: { ...stage('B'), id: 'B' },
    scenes: [{ ...scene('B content'), id: 'B-scene', stageId: 'B' }],
    currentSceneId: 'B-scene',
    chats: [],
  });
  const original = db.stages.get.bind(db.stages);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(db.stages, 'get').mockImplementation(((key: unknown) => {
    return (key === STAGE_ID ? gate : Promise.resolve()).then(() => original(key as string));
  }) as unknown as typeof db.stages.get);
  try {
    const first = useStageStore.getState().loadFromStorage(STAGE_ID);
    await useStageStore.getState().loadFromStorage('B');
    release();
    await first;
    expect(useStageStore.getState().stage?.id).toBe('B');
    expect(useStageStore.getState().scenes[0]?.title).toBe('B content');
  } finally {
    release();
    spy.mockRestore();
  }
});

for (const field of ['chats', 'currentSceneId', 'outlines'] as const) {
  test(`a delayed load cannot overwrite newer ${field}`, async () => {
    await seed();
    useStageStore.setState({
      stage: stage('Existing'),
      scenes: [],
      currentSceneId: null,
      chats: [],
      outlines: [],
    });
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
      const pending = useStageStore.getState().loadFromStorage(STAGE_ID);
      await started;
      if (field === 'chats') useStageStore.getState().setChats([chat('newer chat')]);
      if (field === 'currentSceneId') useStageStore.getState().setCurrentSceneId('newer selection');
      if (field === 'outlines') useStageStore.getState().setOutlines([]);
      const edited = useStageStore.getState();
      release();
      await pending;
      expect(useStageStore.getState()[field]).toBe(edited[field]);
      expect(useStageStore.getState().scenes).toEqual([]);
      await useStageStore.getState().saveToStorage();
    } finally {
      release();
      spy.mockRestore();
    }
  });
}

test('failed navigation flush stays recoverable for its originating classroom', async () => {
  await seed();
  useStageStore.setState({ stage: stage('Existing'), scenes: [scene('Existing')], chats: [] });
  const spy = vi
    .spyOn(db.scenes, 'bulkPut')
    .mockRejectedValueOnce(new DOMException('Disk full', 'QuotaExceededError'));
  try {
    useStageStore.getState().updateScene('scene-1', { title: 'unsaved A edit' });
    useStageStore.getState().setStage({ ...stage('B'), id: 'B' });
    await vi.waitFor(() => expect(useStageStore.getState().failedSaveStageIds).toContain(STAGE_ID));
    expect((await loadStageData(STAGE_ID))?.scenes[0].title).toBe('Existing saved content');
  } finally {
    spy.mockRestore();
  }
  await useStageStore.getState().retryFailedSaves();
  expect((await loadStageData(STAGE_ID))?.scenes[0].title).toBe('unsaved A edit');
  expect(useStageStore.getState().stage?.id).toBe('B');
  expect(useStageStore.getState().failedSaveStageIds).not.toContain(STAGE_ID);
  await useStageStore.getState().saveToStorage();
});

test('retry queued behind a newer successful save cannot resurrect the failed edit', async () => {
  useStageStore.setState({
    stage: stage('Existing'),
    scenes: [scene('failed old edit')],
    chats: [],
  });
  const failure = vi.spyOn(storage, 'saveStageData').mockRejectedValueOnce(new Error('disk full'));
  try {
    await expect(useStageStore.getState().saveToStorage()).rejects.toThrow('disk full');
  } finally {
    failure.mockRestore();
  }
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = storage.saveStageData;
  const slow = vi.spyOn(storage, 'saveStageData').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  try {
    useStageStore.getState().updateScene('scene-1', { title: 'newer successful edit' });
    const newer = useStageStore.getState().saveToStorage();
    await started;
    const retry = useStageStore.getState().retryFailedSaves();
    release();
    await Promise.all([newer, retry]);
    expect((await loadStageData(STAGE_ID))?.scenes[0].title).toBe('newer successful edit');
    expect(useStageStore.getState().failedSaveStageIds).not.toContain(STAGE_ID);
  } finally {
    release();
    slow.mockRestore();
  }
});
