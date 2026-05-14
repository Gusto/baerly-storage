import { createBaerlyClient } from "@baerly/client";

// Same-origin baseUrl works in both dev and production:
//  - Dev: Vite proxies /v1/* to wrangler dev (see vite.config.ts).
//  - Prod: the Worker serves both /v1/* and the static bundle via
//    Workers Assets on the same hostname.
//
// The bearer token is the value passed to `wrangler secret put
// SHARED_SECRET` for the deployed Worker. For dev, set
// VITE_SHARED_SECRET in a .env file (Vite reads it at build time).
const SECRET = import.meta.env.VITE_SHARED_SECRET ?? "dev-shared-secret";

export const client = createBaerlyClient({
  baseUrl: "",
  headers: { Authorization: `Bearer ${SECRET}` },
});
