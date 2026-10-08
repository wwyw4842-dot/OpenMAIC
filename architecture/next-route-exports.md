# Next route export boundary

Next Route modules export HTTP handlers and framework configuration only. Shared token verification lives in `lib/server/access-token-verification.ts`; the status route and lifetime regressions import it there. Its HMAC, signature validation and expiration behavior are unchanged.

Validate the production Webpack build as well as ordinary source typecheck. The former generated Route contract rejected the named helper exports even when the default Turbopack build passed. This is a module-boundary fix with no data migration; reverting it restores the prior source exports and build failure.
