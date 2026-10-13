'use client';
/** Isolated browser fixture: real CanvasArea/SceneProvider/editor/store/IndexedDB.
 * No application route, model request, user profile, or replacement editor logic. */
import React, { useEffect } from 'react';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { useStageStore } from '@/lib/store/stage';
import { useSnapshotStore } from '@/lib/store/snapshot';
import { db } from '@/lib/utils/database';
import * as storage from '@/lib/utils/stage-storage';
import { SaveRecovery } from '@/components/save-recovery';
import { I18nProvider } from '@/lib/hooks/use-i18n';

const runtime = { stage: useStageStore, history: useSnapshotStore, db, storage };
declare global {
  interface Window {
    edu08Dom: typeof runtime;
  }
}
const noop = () => {};
export default function EditorMatrix() {
  useEffect(() => {
    window.edu08Dom = runtime;
  }, []);
  const currentScene = useStageStore((state) => state.getCurrentScene());
  return (
    <I18nProvider>
      <SaveRecovery />
      <div style={{ width: 1100, height: 700 }}>
        <CanvasArea
          currentScene={currentScene}
          mode="autonomous"
          currentSceneIndex={0}
          scenesCount={2}
          engineState="idle"
          isLiveSession={false}
          whiteboardOpen={false}
          sidebarCollapsed={false}
          chatCollapsed={false}
          hideToolbar
          onToggleSidebar={noop}
          onToggleChat={noop}
          onPrevSlide={noop}
          onNextSlide={noop}
          onPlayPause={noop}
          onWhiteboardClose={noop}
          isPresenting={false}
          onTogglePresentation={noop}
        />
      </div>
    </I18nProvider>
  );
}
