# OpenMAIC chat hydration follow-up

Baseline: `32fb053ac5aa0a95cd3afea95b555039accd9f9a` on `main`. HyperClass already has the no-op guard; OpenMAIC did not.

The baseline actual Chromium classroom suite passed seven of eight cases. `production classroom entry rejects stale tab selection and opens retained draft copy` failed with durable scene `scene-0` instead of `scene-1`. The baseline evidence is retained outside the repository in the coordination workspace under `work/edu08-browser-evidence-20261013/om-matrix-first/`.

The independent hook regression has four cases: two unchanged hydration failures on the original source, then four passes with the guard. An initial attempted direct reuse of the HyperClass test lacked OpenMAIC's undeclared testing-library dependency and ran zero cases; that setup failure is retained separately and is not counted as a product failure. The final harness uses the existing React DOM dependency, cleans up every mounted root, and preserves all four contracts.

The product fix is a precise port of the existing HyperClass mechanism. No user data, providers, credentials, or installed application is touched. Browser post-fix acceptance and actual delivery remain open pending separate reports and review.
