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
for (const event of ['undo', 'paste'] as const) {
  test(`same-stack ${event} from the previous DOM cannot dirty a reloaded classroom`, async ({
    page,
  }, info) => {
    await seed(page);
    await editor(page).fill('saved edit');
    await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
    const previous = await editor(page).elementHandle();
    const observed = await page.evaluate(async (event) => {
      const { stage, history, db } = window.edu08Dom;
      const old = document.querySelector('.ProseMirror[contenteditable="true"]')!;
      const owner = stage.getState().persistenceOwner;
      const snapshots = await db.snapshots.toArray();
      let observed: Record<string, unknown> | undefined;
      const unsubscribe = stage.subscribe((state) => {
        if (state.persistenceOwner === owner) return;
        unsubscribe();
        const revision = state.editRevision;
        const expectedContent = structuredClone(
          (state.scenes[0].content as SlideContent).canvas.elements[0],
        );
        const connected = old.isConnected;
        const before = old.textContent;
        if (event === 'undo') {
          const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
          old.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'z', ctrlKey: !mac, metaKey: mac, bubbles: true }),
          );
        } else {
          // The real ProseMirror paste handler parses this authored clipboard
          // synchronously; no replacement editor or delayed mutation observer.
          const data = new DataTransfer();
          data.setData('text/plain', 'stale paste');
          old.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }
        observed = {
          expectedContent,
          connected,
          before,
          oldAfter: old.textContent,
          revision,
          afterRevision: stage.getState().editRevision,
          ownerChanged: stage.getState().persistenceOwner !== owner,
          currentContent: (stage.getState().scenes[0].content as SlideContent).canvas.elements[0],
        };
      });
      try {
        await stage.getState().loadFromStorage('A', true);
      } finally {
        unsubscribe();
      }
      await history.getState().initSnapshotDatabase();
      return { ...observed, snapshots, afterSnapshots: await db.snapshots.toArray() };
    }, event);
    await info.attach('same-stack-owner-event', {
      body: JSON.stringify(observed),
      contentType: 'application/json',
    });
    expect(observed.connected).toBe(true);
    expect(observed.before).toBe('saved edit');
    expect(observed.oldAfter).toContain(event === 'undo' ? 'A original' : 'stale paste');
    expect(observed.ownerChanged).toBe(true);
    expect.soft(observed.afterRevision).toBe(observed.revision);
    expect.soft(observed.currentContent).toEqual(observed.expectedContent);
    expect.soft(observed.afterSnapshots).toEqual(observed.snapshots);
    await expect.poll(() => previous!.evaluate((node) => node.isConnected)).toBe(false);
    await expect(editor(page)).toHaveText('saved edit');
    expect(await content(page, 'A')).toContain('saved edit');
    await editor(page).fill('new lineage edit');
    await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.edu08Dom)).toBe(true);
    await load(page);
    await expect(editor(page)).toHaveText('new lineage edit');
    expect(await content(page, 'A')).toContain('new lineage edit');
  });
}

test('identical HTML after force reload starts a fresh local editor history', async ({ page }) => {
  await seed(page);
  await editor(page).fill('saved edit');
  await page.evaluate(() => window.edu08Dom.history.getState().initSnapshotDatabase());
  const previous = await editor(page).elementHandle();
  const before = await page.evaluate(() => window.edu08Dom.stage.getState().persistenceOwner!.id);
  await load(page);
  expect(await page.evaluate(() => window.edu08Dom.stage.getState().persistenceOwner!.id)).not.toBe(
    before,
  );
  await expect(editor(page)).toHaveText('saved edit');
  await editor(page).press('ControlOrMeta+z');
  await expect.soft(editor(page)).toHaveText('saved edit');
  expect.soft(await content(page)).toContain('saved edit');
  await expect.poll(() => previous!.evaluate((node) => node.isConnected)).toBe(false);
  await editor(page).fill('new edit');
  await editor(page).press('ControlOrMeta+z');
  await expect(editor(page)).toHaveText('saved edit');
  expect(await content(page)).toContain('saved edit');
});
