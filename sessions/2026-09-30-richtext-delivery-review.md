# 2026-09-30 richtext delivery review

Repository: OpenMAIC; PR https://github.com/wwyw4842-dot/OpenMAIC/pull/4. Original exact head 1fa64e895a170283c4192214416b3a812bcdf44c.

Independent review reproduced a blocker: external undo was added to ProseMirror history, and subsequent Ctrl-Z resurrected the undone document and wrote it to the owning element. Replaced that synchronization with a new EditorState containing the existing plugins and new document.

Local validation: 4 real ProseMirror DOM regressions passed, including external undo then Ctrl-Z/redo and continued new-input undo/redo. TypeScript, ESLint (0 errors) and full Prettier check passed. OpenMAIC now includes the same component regression tests and jsdom test dependency.

The original HyperClass head's full unit suite had 3 macOS canonical MP4 failures outside this editor diff; PR #34 handles that separate mechanism. Original OpenMAIC head full365/365 passed. Updated exact CI/independent review and final main tests are pending; no deployment is claimed. Preserve user IndexedDB data on code rollback.
