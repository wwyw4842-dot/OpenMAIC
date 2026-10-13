// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useChatSessions } from '@/components/chat/use-chat-sessions';
import { useStageStore } from '@/lib/store/stage';
import type { ChatSession } from '@/lib/types/chat';
import { db } from '@/lib/utils/database';
import { loadStageData, saveStageData } from '@/lib/utils/stage-storage';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// Exercise the real hook using the repository's existing React DOM dependency.
// OpenMAIC does not declare @testing-library/react in its frozen lock.
const mounted = new Set<() => Promise<void>>();
async function mountChats() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current!: ReturnType<typeof useChatSessions>;
  function Harness() {
    current = useChatSessions();
    return null;
  }
  await act(async () => root.render(<Harness />));
  const unmount = async () => {
    if (!mounted.delete(unmount)) return;
    await act(async () => root.unmount());
    host.remove();
  };
  mounted.add(unmount);
  return {
    get current() {
      return current;
    },
    unmount,
  };
}

function chat(status: ChatSession['status']): ChatSession {
  return {
    id: 'saved-chat',
    type: 'qa',
    title: 'Saved chat',
    status,
    messages: [],
    config: { agentIds: [], maxTurns: 1, currentTurn: 0 },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(async () => {
  useStageStore.setState({ stage: null, scenes: [], chats: [], persistenceOwner: null });
  await db.delete();
  await db.open();
});

afterEach(async () => {
  for (const unmount of mounted) await unmount();
  await useStageStore.getState().saveToStorage();
  useStageStore.setState({ stage: null, scenes: [], chats: [], persistenceOwner: null });
});

async function load(chats: ChatSession[]) {
  await saveStageData('shared', {
    stage: { id: 'shared', name: 'Shared', createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    chats,
  });
  await useStageStore.getState().loadFromStorage('shared', true);
}

for (const restored of [[], [chat('completed')]]) {
  test(`mounting ${restored.length ? 'saved' : 'empty'} chats does not dirty the classroom`, async () => {
    await load(restored);
    const baseline = useStageStore.getState().editRevision;
    const durableRevision = (await loadStageData('shared'))!.contentRevision;
    const { unmount } = await mountChats();
    expect(useStageStore.getState().editRevision).toBe(baseline);
    // Opening a second tab must not make the first tab's CAS baseline stale.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await loadStageData('shared'))!.contentRevision).toBe(durableRevision);
    await unmount();
  });
}

test('a changed chat session still advances the stage revision', async () => {
  await load([chat('completed')]);
  const baseline = useStageStore.getState().editRevision;
  const session = useStageStore.getState().chats[0];
  useStageStore.getState().setChats([{ ...session, title: 'Renamed chat' }]);
  expect(useStageStore.getState().editRevision).toBeGreaterThan(baseline);
  await useStageStore.getState().saveToStorage();
  expect((await loadStageData('shared'))!.chats[0].title).toBe('Renamed chat');
});

test('creating a chat still persists the new session', async () => {
  await load([]);
  const result = await mountChats();
  let id = '';
  await act(async () => {
    id = await result.current.createSession('qa', 'New chat');
  });
  await useStageStore.getState().saveToStorage();
  expect((await loadStageData('shared'))!.chats.map((session) => session.id)).toEqual([id]);
  await result.unmount();
});
