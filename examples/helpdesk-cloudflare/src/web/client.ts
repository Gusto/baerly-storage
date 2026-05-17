import { createBaerlyClient } from "@baerly/client";

// Same-origin baseUrl works in both dev and production:
//  - Dev: `@cloudflare/vite-plugin` runs the Worker inside `workerd`
//    in the same Vite process; /v1/* resolves in-process on :5173.
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
