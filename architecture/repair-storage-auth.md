# Storage and authentication repair invariants

- A classroom save replaces stage metadata, scenes and chat sessions in one Dexie transaction. Failures reject to the caller and preserve the previous persistent version.
- Autosaves capture the originating classroom payload; navigation flushes its pending save, and each classroom write queue preserves invocation order. Navigation responses must still belong to the latest request and must not supersede edits.
- IndexedDB v11 partitions undo rows by stageId. Legacy history lacking an attributable stageId is discarded; saved classroom data is not migrated or deleted.
- Access cookies expire after seven days both in browser attributes and server verification, without future timestamp tolerance. Tokens and signatures require canonical syntax; changing ACCESS_CODE invalidates old signatures.
- LLM server credentials respect configured model lists. Omitted models retain compatibility, an explicit empty list denies all. BYOK and client URLs do not inherit server credentials. Media resolver coverage remains a separate open gate.
