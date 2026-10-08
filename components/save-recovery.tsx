'use client';

import { useState } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';

export function SaveRecovery() {
  const failed = useStageStore((state) => state.failedSaveStageIds);
  const conflicts = useStageStore((state) => state.conflictDrafts);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { t } = useI18n();
  if (!failed.length && !conflicts.length)
    return copiedId ? (
      <div
        role="status"
        className="fixed bottom-4 left-1/2 z-[100] rounded-lg border bg-background p-4 shadow-lg"
      >
        <a href={`/classroom/${encodeURIComponent(copiedId)}`} className="underline">
          {t('saveRecovery.openCopy')}
        </a>
      </div>
    ) : null;
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[100] max-w-xl -translate-x-1/2 rounded-lg border bg-background p-4 shadow-lg"
    >
      {failed.length > 0 && (
        <>
          <p>
            {t('saveRecovery.message', {
              defaultValue:
                'Your changes could not be saved. Keep this tab open and retry after freeing storage.',
            })}
          </p>
          <button
            type="button"
            disabled={busy}
            className="mt-2 underline"
            onClick={async () => {
              setBusy(true);
              try {
                await useStageStore.getState().retryFailedSaves();
              } catch {
                /* Retained payload and alert stay available for another retry. */
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('saveRecovery.retry', { defaultValue: 'Retry saving' })}
          </button>
        </>
      )}
      {conflicts.map((draft) => (
        <div key={draft.id}>
          <p>{t('saveRecovery.conflict', { name: draft.name })}</p>
          <button
            type="button"
            disabled={busy}
            className="mt-2 mr-4 underline"
            onClick={async () => {
              setBusy(true);
              try {
                await useStageStore.getState().loadLatestForConflict(draft.id);
              } catch {
                /* Draft remains retained. */
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('saveRecovery.readLatest')}
          </button>
          <button
            type="button"
            disabled={busy}
            className="mt-2 underline"
            onClick={async () => {
              setBusy(true);
              try {
                setCopiedId(await useStageStore.getState().saveConflictCopy(draft.id));
              } catch {
                /* Draft remains retained. */
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('saveRecovery.saveCopy')}
          </button>
        </div>
      ))}
    </div>
  );
}
