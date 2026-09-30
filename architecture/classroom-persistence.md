# Classroom save and history ownership

Saves transact stage metadata, scenes, chats and outlines together. Navigation flushes a captured originating payload and per-classroom queues preserve order. Failed payloads remain available through a persistent retry banner, including after navigation. A queued retry is skipped if a newer successful save or different failure has superseded its payload.

Undo history is indexed by stage ID. Old unowned rows remain unchanged and can be recovered with exportLegacySnapshots(). History writes use one transaction and a serialized queue, with a 20-entry cap per classroom. Late undo and reads compare editRevision before changing active state.

Validation: 22 storage/history unit regressions per repository, TypeScript and production build, real Chrome quota rollback → retry → refresh. Existing browser suites remain intact. Cross-tab conflicts are an explicit EDU-08 open item; process-local queues are not advertised as cross-tab protection.
