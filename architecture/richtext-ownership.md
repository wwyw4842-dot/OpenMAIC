# Rich text ownership and external history

ProseMirror document transactions write through the current owning element callback synchronously. React rerenders refresh callback ownership; unmount has no delayed content write. External classroom undo or owner content replacement installs a new EditorState using the current document schema and existing plugins, resetting their history so editor Ctrl-Z cannot restore replaced content. New edits start their own functional undo/redo history.

Regression coverage uses real ProseMirror EditorView and DOM: current callback after rerender, focused external undo, immediate unmount, and external undo followed by Ctrl-Z/redo and a new edit with working undo/redo. The test geometry stub affects jsdom scroll only.

This mechanism does not implement cross-tab classroom version conflict control. Production/installed delivery and observation remain separate acceptance gates.
