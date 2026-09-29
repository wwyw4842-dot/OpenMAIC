# Education repair continuation — 2026-09-30

Existing isolated patch continued without importing the main checkout's uncommitted work.

Implemented: one Dexie transaction for stage/scenes/chat; propagated save failure; stage-partitioned v11 snapshots; stage-specific captured autosave payloads flushed at navigation; serial write queue; stale load responses ignored; strict seven-day access token timestamps and signature format in Node and Edge; server LLM model allowlist including explicit-empty deny; deterministic IndexedDB browser fixture readiness. HyperClass also canonicalizes MP4 download paths to support macOS aliases and reject symlink escapes.

Validation: existing full browser suite **13/13** on Chrome, 2 workers. Initial cold Next development compilation exceeded 30s in the classroom tests; the full warmed run passed with original assertions and unchanged timeout. Full unit suite before final allowlist additions was 388 passed; focused provider-config (32 tests) and resolver (4 tests) passed after additions. Typecheck and optimized production build passed. Production HTTP token matrix: 10 assertions passed against the built app (valid, expired, future, malformed, rotated, trailing signature, missing, login/cookie/status). Synthetic credentials only.

Remaining: media model allowlists beyond LLM, rich-text callback ownership, dedicated browser fault injection/save-undo migration matrix, complete real CLI/API MP4 render/audio-duration/cancel matrix, real provider calls, CI/review/merge/release. Unit mocks and original E2E do not close those gates.

Rollback: code commits are mechanism-separated; v11 only removes unattributable legacy undo rows and preserves classroom data. Copy/export the browser profile's IndexedDB before release; do not downgrade the schema on a live profile.
