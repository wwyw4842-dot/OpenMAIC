/** Test-only browser bundle of the real persistence/store/UI modules. Never shipped as an app route. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStageStore, captureStageSave } from '@/lib/store/stage';
import { useSnapshotStore } from '@/lib/store/snapshot';
import { db } from '@/lib/utils/database';
import * as storage from '@/lib/utils/stage-storage';
import { SaveRecovery } from '@/components/save-recovery';
import { I18nProvider } from '@/lib/hooks/use-i18n';

const runtime = { stage: useStageStore, history: useSnapshotStore, db, storage, captureStageSave };
declare global {
  interface Window {
    edu08: typeof runtime;
  }
}
window.edu08 = runtime;
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <SaveRecovery />
  </I18nProvider>,
);
