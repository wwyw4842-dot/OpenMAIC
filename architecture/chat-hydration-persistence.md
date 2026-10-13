# Unchanged chat hydration preserves classroom ownership

Opening an existing classroom restores chat state through the real `useChatSessions` hook. Its new array can still contain exactly the existing session objects. `setChats` now returns before changing state or scheduling a save in that case, including an empty array. A changed session object, insertion, deletion, or reordering continues through the existing revision and persistence path.

The five-line guard is ported from HyperClass commit `dcf5ddf3ffeb35876fdd177774ea1cadb51329d3` (PR 50). No persistence format, public API, or dependency lock changes. This avoids making another tab's CAS baseline stale solely by opening a classroom.

`node scripts/test-chat-hydration.mjs` runs four real React hook/store tests against fixture IndexedDB. It requires all four JSON and JUnit cases, no skips, a successful process exit, and valid reports. Two original-source controls fail because mounting empty/saved chat state increases the edit revision; changing a session and creating a session still pass. The tests use the repository's existing React DOM dependency and do not simulate the hook implementation.

Actual Chromium classroom entry, multi-tab, reload, production deployment, and user-data migration remain distinct evidence. A unit pass does not replace those checks.
