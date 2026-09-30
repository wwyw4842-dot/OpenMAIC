'use client';

import { useState } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';

export function SaveRecovery() {
  const failed = useStageStore((state) => state.failedSaveStageIds);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  if (!failed.length) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[100] max-w-xl -translate-x-1/2 rounded-lg border bg-background p-4 shadow-lg"
    >
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
    </div>
  );
}
