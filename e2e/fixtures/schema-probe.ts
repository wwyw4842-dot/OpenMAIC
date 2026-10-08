import type { Page } from '@playwright/test';

/** Keep native IndexedDB, but prevent the app from upgrading intentionally wrong schemas. */
export async function prepareDatabaseSchema(page: Page, version: number, stores: string[]) {
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Schema probe</title>' }),
  );
  await page.goto('/');
  await page.evaluate(
    ({ version, stores }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database', version);
        request.onupgradeneeded = () => {
          for (const name of stores) {
            request.result.createObjectStore(name, {
              keyPath: name === 'stageOutlines' ? 'stageId' : 'id',
            });
          }
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
    { version, stores },
  );
}

export async function inspectDatabaseSchema(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ version: number; counts: Record<string, number> }>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const counts: Record<string, number> = {};
          const names = Array.from(database.objectStoreNames);
          const transaction = database.transaction(names);
          for (const name of names) {
            const count = transaction.objectStore(name).count();
            count.onsuccess = () => {
              counts[name] = count.result;
            };
          }
          transaction.oncomplete = () => {
            database.close();
            resolve({ version: database.version, counts });
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
  );
}

export async function injectFixtureWriteFailure(page: Page) {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'stageOutlines') {
        throw new DOMException('Injected fixture write failure', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
}
