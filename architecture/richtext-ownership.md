# Rich text ownership and external history

ProseMirror document transactions write through the current owning element callback synchronously. React rerenders refresh callback ownership; unmount has no delayed content write. External classroom undo or owner content replacement installs a new EditorState using the current document schema and existing plugins, resetting their history so editor Ctrl-Z cannot restore replaced content. New edits start their own functional undo/redo history.

Regression coverage uses real ProseMirror EditorView and DOM: current callback after rerender, focused external undo, immediate unmount, and external undo followed by Ctrl-Z/redo and a new edit with working undo/redo. The test geometry stub affects jsdom scroll only.

This mechanism does not implement cross-tab classroom version conflict control. Production/installed delivery and observation remain separate acceptance gates.

## History transaction classification

`isHistoryTransaction` from locked `prosemirror-history` 1.5.0 identifies actual undo/redo transactions. Keyboard shortcuts do not decide whether an edit should omit a new classroom snapshot. An empty undo produces no transaction; a later paste or input-method transaction must still create a snapshot. Shift+Z is ordinary text input. Programmatic undo/redo must retain their history status without a preceding keydown. No public editor callback or persistence format changes.

The three new real ProseMirror tests fail on the previous source and pass with transaction metadata. The existing six editor/scene-owner cases remain intact.

## Browser acceptance boundary

`python3 scripts/test-editor-acceptance.py` copies tracked source plus explicit task fixture files into a private temporary directory, excludes environment files, verifies the installed dependency lock, and builds the actual Next production client. The existing `VERCEL=1` option disables standalone file copying in this fixture build: linked, matching-lock dependencies can be outside the temporary source tree. This gate does not validate standalone packaging; normal product builds and release-artifact checks remain separate. A fixture-only route renders actual CanvasArea, SceneProvider, SceneRenderer, SlideEditor, ProseMirror, stores, and IndexedDB. No editor/store implementation is replaced. The temporary route is removed with the private tree and must never be deployed.

The gate requires nine unit cases and twenty Chromium cases, each with successful JSON/JUnit results and zero skips/retries. Browser cases retain the eight existing production classroom cases and five original cross-tab cases, adding seven DOM cases: 0/100/499 ms classroom switches; identical scene IDs/content ownership; a same-turn old DOM undo after switching scenes; twenty-five edits with history bounds, external undo, branching and reload; and delayed native IndexedDB read delivery. New-owner actions wait for the actual old node to detach; the separate same-turn case explicitly proves an event was delivered before that detachment and could not mutate the new scene.

The runtime exposes fixture data only, runs with a private HOME and sparse environment, uses loopback HTTP and a fresh Chromium profile, and does not call a model or read real user profiles. The actual browser version and per-case outcomes belong in execution reports; adding this gate alone is not acceptance or production deployment evidence. These local/Linux browser checks do not establish native Windows/macOS packaging or provider-service acceptance.
