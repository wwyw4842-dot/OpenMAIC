/**
 * Stage API - AI Agent Toolkit
 *
 * Provides a complete Stage operation interface for AI Agents to create and manage course content
 *
 * Design Principles:
 * 1. Type Safety: Fully leverage TypeScript's type system
 * 2. Ease of Use: Provide high-level abstractions with clear, intuitive API naming
 * 3. Extensibility: Support adding new scene types in the future
 * 4. Idempotency: Multiple calls with the same parameters produce the same result
 * 5. Error Handling: Return explicit success/failure status and error messages
 *
 * @example
 * ```typescript
 * const api = createStageAPI(stageStore);
 *
 * // Create a new scene
 * const sceneId = api.scene.create({
 *   type: 'slide',
 *   title: 'Introduction',
 *   // speech is now in actions
 * });
 *
 * // Add an element
 * const elementId = api.element.add(sceneId, {
 *   type: 'text',
 *   content: 'Hello World',
 *   left: 100,
 *   top: 100
 * });
 *
 * // Highlight an element (teaching feature)
 * api.canvas.highlight(sceneId, elementId, 3000);
 * ```
 */

// Re-export all types
export type {
  APIResult,
  CreateSceneParams,
  CreateElementParams,
  HighlightOptions,
  SpotlightOptions,
  StageStore,
} from './stage-api-types';

// Re-export utility functions that were previously accessible
export {
  generateId,
  validateSceneId,
  getScene,
  createDefaultContent,
  createDefaultSlideContent,
  createDefaultQuizContent,
  createDefaultInteractiveContent,
  createDefaultPBLContent,
} from './stage-api-defaults';

// Import sub-API factories
import { createSceneAPI } from './stage-api-scene';
import { createElementAPI } from './stage-api-element';
import { createCanvasAPI } from './stage-api-canvas';
import { createNavigationAPI } from './stage-api-navigation';
import { createWhiteboardAPI } from './stage-api-whiteboard';
import { createModeAPI, createStageMetaAPI } from './stage-api-mode';
import type { StageStore } from './stage-api-types';

// ==================== Stage API Implementation ====================

/**
 * Create a Stage API instance
 *
 * @param store - Zustand store instance
 * @returns Stage API object
 */
export function createStageAPI(store: StageStore) {
  // Browser stores must use their persistence/revision actions. Server-only
  // stores keep the injected setState behavior and do not need IndexedDB.
  const owningStore: StageStore = {
    getState: store.getState,
    subscribe: store.subscribe,
    setState(partial) {
      const state = store.getState();
      const rest = { ...partial };
      if (partial.stage && (state.updateStage || state.setStage)) {
        (state.updateStage ?? state.setStage)!(partial.stage);
        delete rest.stage;
      }
      if (partial.scenes && state.setScenes) {
        state.setScenes(partial.scenes);
        delete rest.scenes;
      }
      if ('currentSceneId' in partial && state.setCurrentSceneId) {
        state.setCurrentSceneId(partial.currentSceneId);
        delete rest.currentSceneId;
      }
      if (Object.keys(rest).length) store.setState(rest);
    },
  };
  return {
    scene: createSceneAPI(owningStore),
    navigation: createNavigationAPI(owningStore),
    element: createElementAPI(owningStore),
    canvas: createCanvasAPI(owningStore),
    whiteboard: createWhiteboardAPI(owningStore),
    mode: createModeAPI(owningStore),
    stage: createStageMetaAPI(owningStore),
  };
}

// ==================== Type Exports ====================

export type StageAPI = ReturnType<typeof createStageAPI>;
