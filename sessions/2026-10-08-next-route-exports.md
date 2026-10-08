# Production Route export repair (2026-10-08)

A real MP4 production-build acceptance exposed an invalid shared helper exported by the access-code verification Route. The status Route and token tests now import the same verification function from a server library module; no authentication, cookie lifetime or public API change is intended.

Validation: token lifetime regressions 10/10. The original current-main verification Route was restored temporarily for the real Webpack build: it failed with `verifyAccessToken is not a valid Route export field`, exit 1. The same production build after relocation passed. The source was restored safely after the negative control.

Coordinator evidence lives under `work/route-export-evidence-2026-10-08/`. Full unit suite: 56 files / 496 tests, with no skipped tests; changed-file lint, source typecheck, formatting and diff checks passed. Exact PR/CI delivery evidence is recorded separately. This does not claim a production deployment or stability observation.
