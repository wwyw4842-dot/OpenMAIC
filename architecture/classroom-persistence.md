# Classroom save and history ownership

Saves transact stage metadata, scenes, chats and outlines together. Navigation flushes a captured originating payload and per-classroom queues preserve order. Failed payloads remain available through a retry banner after navigation. A queued retry is skipped if a newer successful save or different failure supersedes its originating request.

Undo history is indexed by stage ID, with an optional persisted cursor and session ID. Scenes, undo/redo cursor and snapshot mutations commit in the same IndexedDB transaction. Undo publishes visible scenes only after commit. Failed history writes retain the history mutation and its captured body together for the existing retry action; retry cannot save a body without its missing history mutation. Old unowned rows remain unchanged and can be recovered with exportLegacySnapshots(). Unmatched owned history remains stored while a new safe session starts. Active history has a 20-entry cap.

Late undo and reads compare editRevision before changing active state. A history append captured before a newer explicit save retains its undo point while updating only history metadata, preserving the newer durable classroom body. Cross-tab version conflicts remain EDU-08 work; process-local queues do not protect against multiple tabs.

The injected browser Stage API uses persistence/revision setters. Metadata changes preserve scenes, current selection and chats; changing classroom owner uses the navigation setter. Server-only injected stores keep their existing setState behavior. Server classroom hydration and PBL edits use scene setters so captured autosaves include their scenes and increment editRevision. Direct scene setState calls must not bypass these save/revision guarantees.

The Stage component initializes history for the active classroom after content is available. Existing browser suites retain their assertions, including real IndexedDB quota rollback, retry and reload. Release and production observation remain separate acceptance requirements.
