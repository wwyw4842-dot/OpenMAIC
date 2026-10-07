# EDU-04/05 classroom persistence delivery

Continued the existing PR and prior prepared followup patches in this isolated delivery checkout. The original user worktree, including its untracked IndexedDB setup file, was not changed.

The prior followup connects browser Stage API and PBL edits to revision/autosave setters, autosaves server-hydrated scenes, initializes history at the Stage entry, persists the undo cursor/session and combines history with its classroom transaction. Independent review reproduced two additional failures: stage metadata edits cleared scenes through the navigation setter; an older queued history append replaced a newer explicit save. Added metadata-only update and history version ownership checks. Failed history transactions now retain body, mutation and post-commit UI publication for the existing retry banner.

Initial prepared state: 32 storage/history/API regressions passed per repository. Before-fix metadata regression failed with an empty scene list; before-fix delayed snapshot regression failed with durable title snapshot edit instead of newer saved edit. The strengthened targeted set passes 36/36 in HyperClass. Final target integration and full browser evidence are recorded below once completed.

Initial complete suites before latest-main integration: HyperClass 692 passed and 3 existing MP4 download failures (separate PR 34); OpenMAIC 401/401. TypeScript passed in both repositories. These local results are not GitHub CI.

Remaining acceptance: real deployment/installation, 30-minute and 24-hour observation, cross-tab conflict handling and independent route-level delayed server hydration ownership. The root coordinator owns ledger and merge decisions.
