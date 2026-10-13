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

## Reload lineage boundary (EDU-08 follow-up)

`scene.id` and `stage.id` identify durable records, while `persistenceOwner` identifies the loaded client lineage. A supported `loadFromStorage(id, true)` replaces the owner while retaining record IDs and possibly identical HTML. The old React subtree may still receive an input or undo event before commit. Scene writes and the history hook therefore capture the owner and stage at render and check both again when invoked. An old callback cannot dirty the newly loaded body, advance `editRevision`, append a snapshot, or move its history cursor. Public store and context APIs are unchanged.

The provider's child key uses the existing owner ID so a successful reload resets ProseMirror's local history even when the HTML and scene ID have not changed. Normal commits only update the same owner's revision, so they retain the editor and its normal typing/undo behavior. Scene changes within the same lineage still let a captured scene callback update its originating scene; this is not a blanket current-scene check.

Normal creation, import, and conflict-copy assign fresh scene IDs, and IndexedDB's scene primary key is global. The regression does not claim that storing duplicate scene IDs in two classrooms is a supported product contract. It uses actual same-classroom force reload and the public setStage/setScenes path with distinct IDs.

The acceptance gate preserves the previous 9 unit and 20 browser cases and adds 6 real provider/history/store unit cases and 3 real Chromium cases. The browser controls deliver an authored paste or undo to the still-connected old DOM synchronously from the real store's owner-change notification, then check store, native IndexedDB snapshots, DOM replacement, new edits, and reload. A separate same-HTML reload verifies that old local undo cannot return. The fixture route exists only in the private build; no user profile, provider, production data, or installed application is involved.
