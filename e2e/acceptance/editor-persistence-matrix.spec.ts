import { test, expect, type Page } from '@playwright/test';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import type { SlideContent } from '@/lib/types/stage';
import type {} from '../fixtures/editor-matrix-runtime';

const editor = (page: Page) => page.locator('.ProseMirror[contenteditable="true"]');
async function load(page: Page, id = 'A') {
  await page.evaluate(async (id) => {
    await window.edu08Dom.stage.getState().loadFromStorage(id, true);
    await window.edu08Dom.history.getState().initSnapshotDatabase();
  }, id);
}
async function open(page: Page) {
  await page.goto('/edu08-editor-matrix');
  await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
}
async function content(page: Page, id?: string) {
  return page
    .evaluate(async (id) => {
      const data = id
        ? await window.edu08Dom.storage.loadStageData(id)
        : window.edu08Dom.stage.getState();
      const scene = data!.scenes.find((scene) => scene.id === data!.currentSceneId)!;
      return (scene.content as SlideContent).canvas.elements[0] as { content: string };
    }, id)
    .then((element) => element.content);
}
async function seed(page: Page) {
  await open(page);
  await page.evaluate(async (theme) => {
    for (const id of ['A', 'B']) {
      const scenes = [0, 1].map((i) => ({
        id: `${id}-${i}`,
        stageId: id,
        title: `${id} scene ${i}`,
        type: 'slide' as const,
        order: i,
        createdAt: 1,
        updatedAt: 1,
        content: {
          type: 'slide' as const,
          canvas: {
            id: 'same-canvas',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme,
            elements: [
              {
                type: 'text' as const,
                id: 'same-text-element',
                content: `<p>${id === 'A' && i === 0 ? 'A original' : 'shared content'}</p>`,
                left: 40,
                top: 40,
                width: 500,
                height: 80,
                rotate: 0,
                defaultColor: '#000000',
                defaultFontName: 'Arial',
              },
            ],
          },
        },
      }));
      await window.edu08Dom.storage.saveStageData(id, {
        stage: { id, name: `${id} classroom`, createdAt: 1, updatedAt: 1 },
        scenes,
        currentSceneId: scenes[0].id,
        chats: [],
        outlines: [],
      });
    }
  }, defaultTheme);
  await load(page);
  await expect(editor(page)).toHaveText('A original');
}

test.beforeEach(async ({ context, baseURL }) => {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === new URL(baseURL!).origin || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  // Only authored fixture API data, never a provider or user profile.
  await context.route('**/api/server-providers', (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.addInitScript(() => localStorage.setItem('locale', 'en-US'));
});
for (const delayMs of [0, 100, 499])
  test(`DOM edits keep owner across a ${delayMs}ms classroom switch and reload`, async ({
    page,
  }, info) => {
    await seed(page);
    await editor(page).fill('shared content');
    expect(await content(page)).toContain('shared content');
    const previousEditor = await editor(page).elementHandle();
    const started = Date.now();
    await page.waitForTimeout(delayMs);
    await load(page, 'B');
    await expect.poll(() => previousEditor!.evaluate((node) => node.isConnected)).toBe(false);
    await info.attach('actual-switch-delay', {
      body: JSON.stringify({ requestedMs: delayMs, observedMs: Date.now() - started }),
      contentType: 'application/json',
    });
    await expect(editor(page)).toHaveText('shared content');
    // Both owners deliberately have identical HTML and element IDs: local editor
    // history must still be reset by the actual CanvasArea ownership boundary.
    await editor(page).press('ControlOrMeta+z');
    await expect(editor(page)).toHaveText('shared content');
    await editor(page).fill('B edited');
    await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
    expect(await content(page, 'A')).toContain('shared content');
    expect(await content(page, 'B')).toContain('B edited');
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
    await load(page, 'B');
    await expect(editor(page)).toHaveText('B edited');
    expect(await content(page)).toContain('B edited');
    await load(page, 'A');
    await expect(editor(page)).toHaveText('shared content');
    expect(await content(page, 'A')).toContain('shared content');
  });

test('identical scene content cannot reuse another scene editor history', async ({ page }) => {
  await seed(page);
  await editor(page).fill('shared content');
  const previousEditor = await editor(page).elementHandle();
  await page.evaluate(() => window.edu08Dom.stage.getState().setCurrentSceneId('A-1'));
  // Identical text alone cannot signal that React installed the new owner.
  await expect.poll(() => previousEditor!.evaluate((node) => node.isConnected)).toBe(false);
  await expect(editor(page)).toHaveText('shared content');
  await editor(page).press('ControlOrMeta+z');
  await expect(editor(page)).toHaveText('shared content');
  await editor(page).fill('second scene edited');
  await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
  expect(await content(page)).toContain('second scene edited');
  expect(await content(page, 'A')).toContain('second scene edited');
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
  await load(page);
  await expect(editor(page)).toHaveText('second scene edited');
  await page.evaluate(() => window.edu08Dom.stage.getState().setCurrentSceneId('A-0'));
  await expect(editor(page)).toHaveText('shared content');
});

test('same-turn undo on the old DOM cannot write into the newly selected scene', async ({
  page,
}) => {
  await seed(page);
  await editor(page).fill('shared content');
  const previousEditor = await editor(page).elementHandle();
  const during = await page.evaluate(() => {
    const old = document.querySelector('.ProseMirror[contenteditable="true"]')!;
    const before = old.textContent;
    window.edu08Dom.stage.getState().setCurrentSceneId('A-1');
    const connectedBeforeUndo = old.isConnected;
    // React has not committed its keyed owner replacement yet. This deliberately
    // delivers the event to the old node in the same JavaScript turn.
    const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
    old.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: !mac, metaKey: mac, bubbles: true }),
    );
    const state = window.edu08Dom.stage.getState();
    const text = (id: string) =>
      (
        (state.scenes.find((scene) => scene.id === id)!.content as SlideContent).canvas
          .elements[0] as { content: string }
      ).content;
    return {
      before,
      connectedBeforeUndo,
      oldAfterUndo: old.textContent,
      currentSceneId: state.currentSceneId,
      original: text('A-0'),
      selected: text('A-1'),
    };
  });
  expect(during.connectedBeforeUndo).toBe(true);
  expect(during.before).toBe('shared content');
  expect(during.oldAfterUndo).toBe('A original');
  expect(during.currentSceneId).toBe('A-1');
  expect(during.original).toContain('A original');
  expect(during.selected).toContain('shared content');
  await expect.poll(() => previousEditor!.evaluate((node) => node.isConnected)).toBe(false);
  await expect(editor(page)).toHaveText('shared content');
  await page.evaluate(() => window.edu08Dom.stage.getState().saveToStorage());
  expect(await content(page, 'A')).toContain('shared content');
  await editor(page).fill('new scene edit after old event');
  await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
  await load(page);
  await expect(editor(page)).toHaveText('new scene edit after old event');
  await page.evaluate(() => window.edu08Dom.stage.getState().setCurrentSceneId('A-0'));
  await expect(editor(page)).toHaveText('A original');
});

test('25 DOM edits cap history, external undo resets local editor history, and a branch survives reload', async ({
  page,
}) => {
  await seed(page);
  for (let i = 1; i <= 25; i++) {
    await editor(page).fill(`edit ${i}`);
    await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
  }
  const history = await page.evaluate(async () => ({
    count: await window.edu08Dom.db.snapshots.where('stageId').equals('A').count(),
    length: window.edu08Dom.history.getState().snapshotLength,
    canUndo: window.edu08Dom.history.getState().canUndo(),
  }));
  expect(history).toEqual({ count: 20, length: 20, canUndo: true });
  await page.evaluate(() => window.edu08Dom.history.getState().undo());
  await expect(editor(page)).toHaveText('edit 24');
  expect(await content(page)).toContain('edit 24');
  expect(await content(page, 'A')).toContain('edit 24');
  await editor(page).press('ControlOrMeta+z');
  await expect(editor(page)).toHaveText('edit 24');
  await editor(page).fill('branched edit');
  await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
  expect(await page.evaluate(() => window.edu08Dom.history.getState().canRedo())).toBe(false);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
  await load(page);
  await expect(editor(page)).toHaveText('branched edit');
  expect(await content(page)).toContain('branched edit');
  expect(await content(page, 'A')).toContain('branched edit');
  expect(await page.evaluate(() => window.edu08Dom.history.getState().canRedo())).toBe(false);
});

test('a delayed real IndexedDB read cannot publish over the newer classroom DOM', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => {
    const db = window.edu08Dom.db;
    const original = db.transaction.bind(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = window as unknown as {
      releaseRead: () => void;
      pendingRead: Promise<void>;
      readHeld: boolean;
      restoreRead: () => void;
    };
    state.readHeld = false;
    // Preserve the native transaction and its exact result; delay delivery only
    // after its promise resolves, so no synthetic record/transaction is used.
    db.transaction = (async (...args: Parameters<typeof db.transaction>) => {
      const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
      if (
        !state.readHeld &&
        args[0] === 'r' &&
        (result as { stage?: { id: string } } | null)?.stage?.id === 'A'
      ) {
        state.readHeld = true;
        await gate;
      }
      return result;
    }) as typeof db.transaction;
    state.restoreRead = () => {
      db.transaction = original;
    };
    state.releaseRead = release;
    state.pendingRead = window.edu08Dom.stage.getState().loadFromStorage('A', true);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { readHeld: boolean }).readHeld))
    .toBe(true);
  await load(page, 'B');
  await editor(page).fill('B newer than delayed A');
  await page.evaluate(async () => {
    const state = window as unknown as {
      releaseRead: () => void;
      pendingRead: Promise<void>;
      restoreRead: () => void;
    };
    state.releaseRead();
    await state.pendingRead;
    state.restoreRead();
    await window.edu08Dom.history.getState().initSnapshotDatabase();
  });
  await expect(editor(page)).toHaveText('B newer than delayed A');
  expect(await page.evaluate(() => window.edu08Dom.stage.getState().stage?.id)).toBe('B');
  expect(await content(page, 'A')).toContain('A original');
  expect(await content(page, 'B')).toContain('B newer than delayed A');
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
  await load(page, 'B');
  await expect(editor(page)).toHaveText('B newer than delayed A');
});
