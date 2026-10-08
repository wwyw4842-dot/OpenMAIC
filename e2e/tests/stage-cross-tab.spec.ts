import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import type {} from '../fixtures/cross-tab-runtime';

let bundle: string;
test.beforeAll(async () => {
  // esbuild is Vite's existing locked dependency; no extra browser fixture dependency.
  const require = createRequire(resolve(process.cwd(), 'package.json'));
  const viteRequire = createRequire(require.resolve('vitest'));
  const esbuild = viteRequire(
    viteRequire.resolve('esbuild', { paths: [viteRequire.resolve('vite')] }),
  ) as {
    build: (options: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>;
  };
  const result = await esbuild.build({
    entryPoints: ['e2e/fixtures/cross-tab-runtime.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
  });
  bundle = result.outputFiles![0].text;
});

async function install(context: BrowserContext) {
  await context.route('**/edu08-runtime', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div><script src="/edu08-runtime.js"></script>',
    }),
  );
  await context.route('**/edu08-runtime.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: bundle }),
  );
  await context.route('**/api/server-providers', (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await context.addInitScript(() => localStorage.setItem('locale', 'en-US'));
}
async function open(page: Page) {
  await page.goto('/edu08-runtime');
  await expect.poll(() => page.evaluate(() => !!window.edu08)).toBe(true);
}
async function seed(page: Page, legacy = false) {
  await page.evaluate(
    async ({ theme, legacy }) => {
      const { db, storage } = window.edu08;
      const data = {
        stage: { id: 'shared', name: 'Shared classroom', createdAt: 1, updatedAt: 1 },
        scenes: [
          {
            id: 'shared-scene',
            stageId: 'shared',
            type: 'slide' as const,
            title: 'Original',
            order: 0,
            content: {
              type: 'slide' as const,
              canvas: {
                id: 'canvas',
                elements: [],
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
              },
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        currentSceneId: 'shared-scene',
        chats: [],
        outlines: [],
      };
      if (legacy) {
        await db.stages.put(data.stage);
        await db.scenes.bulkPut(data.scenes);
      } else await storage.saveStageData('shared', data);
    },
    { theme: defaultTheme, legacy },
  );
}
async function load(page: Page) {
  await page.evaluate(async () => {
    await window.edu08.stage.getState().loadFromStorage('shared');
    await window.edu08.history.getState().initSnapshotDatabase();
  });
}
async function read(page: Page) {
  return page.evaluate(() => window.edu08.storage.loadStageData('shared'));
}
async function pair(context: BrowserContext, page: Page, legacy = false) {
  await install(context);
  await open(page);
  await seed(page, legacy);
  await load(page);
  const second = await context.newPage();
  await open(second);
  await load(second);
  return second;
}

// These tabs share Chrome's actual same-origin IndexedDB and execute each repository's real modules.
test('two tabs reject stale metadata, keep drafts through reload, and copy without touching source', async ({
  context,
  page,
}) => {
  const b = await pair(context, page);
  await page.evaluate(async () => {
    window.edu08.stage.getState().updateScene('shared-scene', { title: 'A new content' });
    await window.edu08.stage.getState().saveToStorage();
  });
  const conflict = await b.evaluate(async () => {
    const s = window.edu08.stage.getState();
    s.updateStage({ ...s.stage!, name: 'B metadata edit' });
    try {
      await s.saveToStorage();
      return false;
    } catch (error) {
      return String(error).includes('conflict');
    }
  });
  expect(conflict).toBe(true);
  await expect(b.getByRole('alert')).toContainText('changed in another tab');
  expect((await read(page))!.scenes[0].title).toBe('A new content');
  await b.evaluate(() => window.edu08.stage.getState().retryFailedSaves());
  expect((await read(page))!.stage.name).toBe('Shared classroom');
  await b.reload();
  await load(b);
  await expect(b.getByRole('button', { name: 'Read latest (keep draft)' })).toBeVisible();
  await b.getByRole('button', { name: 'Read latest (keep draft)' }).click();
  await expect(b.getByRole('button', { name: 'Save draft as a copy' })).toBeVisible();
  await b.getByRole('button', { name: 'Save draft as a copy' }).click();
  await expect(b.getByRole('alert')).toBeHidden();
  const copies = await b.evaluate(async () =>
    (await window.edu08.storage.listStages()).filter((stage) => stage.id !== 'shared'),
  );
  expect(copies).toHaveLength(1);
  const copy = await b.evaluate((id) => window.edu08.storage.loadStageData(id), copies[0].id);
  expect(copy!.stage.name).toBe('B metadata edit (copy)');
  expect(copy!.scenes[0].title).toBe('Original');
  expect(copy!.scenes[0].id).not.toBe('shared-scene');
  expect((await read(page))!.scenes[0].title).toBe('A new content');
});

test('native transaction serializes duplicate requests from two tabs', async ({
  context,
  page,
}) => {
  const b = await pair(context, page);
  const request = await read(page);
  request!.scenes[0].title = 'one winner';
  const run = (tab: Page) =>
    tab.evaluate(async (data) => {
      try {
        await window.edu08.storage.saveStageData('shared', data!);
        return 'committed';
      } catch (error) {
        return String(error).includes('conflict') ? 'conflict' : String(error);
      }
    }, request);
  expect((await Promise.all([run(page), run(b)])).sort()).toEqual(['committed', 'conflict']);
  expect((await read(page))!.scenes[0].title).toBe('one winner');
});

test('reversed arrival loses at CAS and cannot publish old body', async ({ context, page }) => {
  const b = await pair(context, page);
  const stale = await read(page);
  await b.evaluate(async () => {
    window.edu08.stage.getState().updateScene('shared-scene', { title: 'arrived first' });
    await window.edu08.stage.getState().saveToStorage();
  });
  const loser = await page.evaluate(async (data) => {
    data!.scenes[0].title = 'late old result';
    try {
      await window.edu08.storage.saveStageData('shared', data!);
      return false;
    } catch (error) {
      return String(error).includes('conflict');
    }
  }, stale);
  expect(loser).toBe(true);
  expect((await read(page))!.scenes[0].title).toBe('arrived first');
});

test('undo conflict rolls back history and cancelled undo leaves new classroom alone', async ({
  context,
  page,
}) => {
  await install(context);
  await open(page);
  await seed(page);
  await load(page);
  await page.evaluate(async () => {
    window.edu08.stage.getState().updateScene('shared-scene', { title: 'edited' });
    await window.edu08.history.getState().addSnapshot();
  });
  const b = await context.newPage();
  await open(b);
  await load(b);
  const rows = await page.evaluate(() => window.edu08.db.snapshots.toArray());
  await page.evaluate(() => window.edu08.history.getState().undo());
  const undoConflict = await b.evaluate(async () => {
    try {
      await window.edu08.history.getState().undo();
      return false;
    } catch (error) {
      return String(error).includes('conflict');
    }
  });
  expect(undoConflict).toBe(true);
  expect(await page.evaluate(() => window.edu08.db.snapshots.toArray())).toEqual(rows);
  expect(await b.evaluate(() => window.edu08.stage.getState().scenes[0].title)).toBe('edited');
  expect((await read(page))!.scenes[0].title).toBe('Original');
  await page.evaluate(async () => {
    await window.edu08.history.getState().redo();
    const pending = window.edu08.history.getState().undo();
    window.edu08.stage
      .getState()
      .setStage({ id: 'new-owner', name: 'New owner', createdAt: 1, updatedAt: 1 });
    await pending;
    await window.edu08.stage.getState().saveToStorage();
  });
  expect(await page.evaluate(() => window.edu08.stage.getState().stage!.id)).toBe('new-owner');
  expect((await read(page))!.scenes[0].title).toBe('edited');
});

test('legacy zero version is upgraded lazily and fresh instance recovers latest', async ({
  context,
  page,
}) => {
  const b = await pair(context, page, true);
  await page.evaluate(async () => {
    window.edu08.stage.getState().updateScene('shared-scene', { title: 'legacy latest' });
    await window.edu08.stage.getState().saveToStorage();
  });
  const stale = await b.evaluate(async () => {
    window.edu08.stage.getState().updateScene('shared-scene', { title: 'legacy old' });
    try {
      await window.edu08.stage.getState().saveToStorage();
      return false;
    } catch (error) {
      return String(error).includes('conflict');
    }
  });
  expect(stale).toBe(true);
  await page.reload();
  await load(page);
  expect(await page.evaluate(() => window.edu08.stage.getState().scenes[0].title)).toBe(
    'legacy latest',
  );
  expect(await page.evaluate(() => window.edu08.db.verno)).toBe(11);
});
