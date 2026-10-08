import {
  prepareDatabaseSchema,
  inspectDatabaseSchema,
  injectFixtureWriteFailure,
} from '../fixtures/schema-probe';
import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const TEST_STAGE_ID = 'e2e-test-stage';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/** Seed IndexedDB with stage + 3 scenes using raw IndexedDB API */
async function seedDatabase(page: import('@playwright/test').Page) {
  // Inject settings before navigating so it's available immediately on load
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);

  // Navigate first so Dexie can initialize v11 (native IndexedDB version 110).
  // Poll an awaited result; an async waitForFunction predicate returns a truthy Promise.
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await indexedDB.databases()).some(
            (db) => db.name === 'MAIC-Database' && Number(db.version) >= 110,
          ),
        ),
      { timeout: 5000, message: 'Dexie schema is not ready' },
    )
    .toBe(true);

  // Now seed data by opening the DB at its current version (no upgrade).
  // Opening without a version number returns the current version without triggering
  // onupgradeneeded, so we can safely write to the already-initialized schema.
  await page.evaluate(
    ({ stageId, theme }) => {
      return new Promise<void>((resolve, reject) => {
        // Open without specifying version — uses current DB version, no upgrade event
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (
            db.version < 110 ||
            !['stages', 'scenes', 'stageOutlines'].every((name) =>
              db.objectStoreNames.contains(name),
            )
          ) {
            db.close();
            reject(new Error('Dexie schema is not ready'));
            return;
          }
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          let writeError: unknown;
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(writeError || tx.error || new Error('Fixture transaction aborted'));
          };
          try {
            const now = Date.now();

            tx.objectStore('stages').put({
              id: stageId,
              name: '光合作用',
              description: '',
              language: 'zh-CN',
              style: 'professional',
              createdAt: now,
              updatedAt: now,
            });

            // Scene content uses SlideContent shape: { type: 'slide', canvas: Slide }
            const makeSlideContent = (title: string, elId: string) => ({
              type: 'slide',
              canvas: {
                id: `slide-${elId}`,
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
                elements: [
                  {
                    type: 'text',
                    id: `el-${elId}`,
                    content: title,
                    left: 50,
                    top: 50,
                    width: 900,
                    height: 100,
                  },
                ],
              },
            });

            const scenes = [
              {
                id: 'scene-0',
                stageId,
                type: 'slide',
                title: '基本概念',
                order: 0,
                content: makeSlideContent('基本概念', '0'),
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'scene-1',
                stageId,
                type: 'slide',
                title: '光反应',
                order: 1,
                content: makeSlideContent('光反应', '1'),
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'scene-2',
                stageId,
                type: 'slide',
                title: '暗反应',
                order: 2,
                content: makeSlideContent('暗反应', '2'),
                createdAt: now,
                updatedAt: now,
              },
            ];
            for (const scene of scenes) {
              tx.objectStore('scenes').put(scene);
            }

            // Empty outlines = all scenes generated, no pending work
            // StageOutlinesRecord requires createdAt + updatedAt
            tx.objectStore('stageOutlines').put({
              stageId,
              outlines: [],
              createdAt: now,
              updatedAt: now,
            });
          } catch (error) {
            writeError = error;
            try {
              tx.abort();
            } catch {
              db.close();
              reject(error);
            }
          }
        };

        request.onerror = () => reject(request.error);
      });
    },
    { stageId: TEST_STAGE_ID, theme: defaultTheme },
  );
}

test.describe('Classroom Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await seedDatabase(page);
  });

  test('loads classroom and switches scenes', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // Sidebar shows 3 scenes
    await expect(classroom.sidebarScenes).toHaveCount(3, { timeout: 10_000 });

    // First scene title visible
    await expect(classroom.getSceneTitle(0)).toContainText('基本概念');

    // Click second scene
    await classroom.clickScene(1);

    // Verify second scene is now active — heading in the top bar shows the current scene name
    await expect(page.getByRole('heading', { name: '光反应' })).toBeVisible();
  });

  test('real IndexedDB quota failure rolls back and retry survives reload', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes).toHaveCount(3);
    const before = await page.evaluate(async (stageId) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('MAIC-Database');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const tx = database.transaction('stages');
      const record = await new Promise<Record<string, unknown>>((resolve) => {
        const read = tx.objectStore('stages').get(stageId);
        read.onsuccess = () => resolve(read.result);
      });
      database.close();
      const prototype = IDBObjectStore.prototype;
      const put = prototype.put;
      (window as unknown as { restorePut: () => void }).restorePut = () => {
        prototype.put = put;
      };
      prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'scenes')
          throw new DOMException('Injected full disk', 'QuotaExceededError');
        return put.apply(this, args);
      };
      return record;
    }, TEST_STAGE_ID);
    await classroom.clickScene(1);
    await expect(
      page.getByRole('alert').filter({ hasText: /尚未|could not be saved/ }),
    ).toContainText(/尚未|could not be saved/);
    const readStage = () =>
      page.evaluate(async (stageId) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open('MAIC-Database');
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const tx = database.transaction(['stages', 'scenes']);
        const stage = await new Promise<Record<string, unknown>>((resolve) => {
          const request = tx.objectStore('stages').get(stageId);
          request.onsuccess = () => resolve(request.result);
        });
        const scenes = await new Promise<unknown[]>((resolve) => {
          const request = tx.objectStore('scenes').getAll();
          request.onsuccess = () => resolve(request.result);
        });
        database.close();
        return { stage, scenes };
      }, TEST_STAGE_ID);
    expect((await readStage()).stage).toEqual(before);
    expect((await readStage()).scenes).toHaveLength(3);
    await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
    await page.getByRole('button', { name: /重试保存|重試儲存|Retry saving/ }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: /尚未|could not be saved/ }),
    ).toBeHidden();
    expect((await readStage()).stage.currentSceneId).toBe('scene-1');
    await page.reload();
    await expect(page.getByRole('heading', { name: '光反应' })).toBeVisible();
  });

  test('server classroom hydration autosaves its scenes before reload', async ({ page }) => {
    const stageId = 'server-hydration-stage';
    const now = Date.now();
    const classroom = {
      stage: { id: stageId, name: 'Server classroom', createdAt: now, updatedAt: now },
      scenes: [
        {
          id: 'server-hydration-scene',
          stageId,
          type: 'slide',
          title: 'Server scene',
          order: 0,
          content: {
            type: 'slide',
            canvas: {
              id: 'server-slide',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: defaultTheme,
              elements: [
                {
                  type: 'text',
                  id: 'server-text',
                  content: '<p>Server content</p>',
                  left: 50,
                  top: 50,
                  width: 900,
                  height: 100,
                },
              ],
            },
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    let serverLoads = 0;
    await page.route(`**/api/classroom?id=${stageId}`, async (route) => {
      serverLoads += 1;
      await route.fulfill({ json: { success: true, classroom } });
    });
    await page.goto(`/classroom/${stageId}`);
    await expect(page.locator('[data-testid="scene-item"]')).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('MAIC-Database');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const scenes = await new Promise<Array<{ stageId: string; title: string }>>(
            (resolve, reject) => {
              const request = database.transaction('scenes').objectStore('scenes').getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            },
          );
          database.close();
          return scenes.filter((scene) => scene.stageId === id).map((scene) => scene.title);
        }, stageId),
      )
      .toEqual(['Server scene']);
    await page.reload();
    await expect(page.locator('[data-testid="scene-item"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Server scene' })).toBeVisible();
    expect(serverLoads).toBe(1);
  });
});

test.describe('Classroom fixture schema readiness regression', () => {
  const stores = ['stages', 'scenes', 'stageOutlines'];

  test('rejects an old version with zero fixture writes', async ({ page }) => {
    await prepareDatabaseSchema(page, 100, stores);
    await expect(seedDatabase(page)).rejects.toThrow('Dexie schema is not ready');
    expect(await inspectDatabaseSchema(page)).toEqual({
      version: 100,
      counts: { stages: 0, scenes: 0, stageOutlines: 0 },
    });
  });

  test('rejects a missing store with zero fixture writes', async ({ page }) => {
    await prepareDatabaseSchema(page, 110, ['stages', 'scenes']);
    await expect(seedDatabase(page)).rejects.toThrow('Dexie schema is not ready');
    expect(await inspectDatabaseSchema(page)).toEqual({
      version: 110,
      counts: { stages: 0, scenes: 0 },
    });
  });

  test('resolves only after the fixture transaction commits', async ({ page }) => {
    await prepareDatabaseSchema(page, 110, stores);
    await seedDatabase(page);
    expect(await inspectDatabaseSchema(page)).toEqual({
      version: 110,
      counts: { stages: 1, scenes: 3, stageOutlines: 1 },
    });
  });

  test('rejects a synchronous write failure and rolls back all stores', async ({ page }) => {
    test.setTimeout(8000);
    await prepareDatabaseSchema(page, 110, stores);
    await injectFixtureWriteFailure(page);
    await expect(seedDatabase(page)).rejects.toThrow('Injected fixture write failure');
    expect(await inspectDatabaseSchema(page)).toEqual({
      version: 110,
      counts: { stages: 0, scenes: 0, stageOutlines: 0 },
    });
  });
});

test('production classroom entry rejects stale tab selection and opens retained draft copy', async ({
  context,
  page,
}) => {
  await context.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  await context.route('**/api/server-providers', (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await seedDatabase(page);
  const a = new ClassroomPage(page);
  await a.goto(TEST_STAGE_ID);
  await expect(a.sidebarScenes).toHaveCount(3);
  const saved = (tab: import('@playwright/test').Page) =>
    tab.evaluate(async (id) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('MAIC-Database');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const record = await new Promise<{
        currentSceneId?: string;
        snapshotCursor?: number;
        contentRevision?: number;
      }>((resolve, reject) => {
        const req = database.transaction('stages').objectStore('stages').get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      database.close();
      return record;
    }, TEST_STAGE_ID);
  await expect.poll(async () => Number.isInteger((await saved(page)).snapshotCursor)).toBe(true);
  const bPage = await context.newPage();
  const b = new ClassroomPage(bPage);
  await b.goto(TEST_STAGE_ID);
  await expect(b.sidebarScenes).toHaveCount(3);
  await a.clickScene(1);
  await expect.poll(async () => (await saved(page)).currentSceneId).toBe('scene-1');
  await b.clickScene(2);
  await expect(bPage.getByRole('alert')).toContainText('changed in another tab');
  expect((await saved(page)).currentSceneId).toBe('scene-1');
  await bPage.reload();
  await expect(b.sidebarScenes).toHaveCount(3);
  await bPage.getByRole('button', { name: 'Read latest (keep draft)' }).click();
  await expect(bPage.getByRole('heading', { name: '光反应' })).toBeVisible();
  await bPage.getByRole('button', { name: 'Save draft as a copy' }).click();
  await expect(bPage.getByRole('alert')).toBeHidden();
  const link = bPage.getByRole('link', { name: 'Copy saved. Open the copied classroom' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(bPage).not.toHaveURL(new RegExp(`/classroom/${TEST_STAGE_ID}$`));
  await expect(bPage.getByRole('heading', { name: '暗反应' })).toBeVisible();
  await expect(b.sidebarScenes).toHaveCount(3);
  expect((await saved(page)).currentSceneId).toBe('scene-1');
});
