import { createBaerlyClient } from "baerly-storage/client";
import config from "../../baerly.config.ts";

// Same-origin baseUrl works in both dev and production:
//  - Dev:  `baerlyDevAuth` in vite.config.ts injects Authorization
//          server-side; this file never sees the bearer.
//  - Prod: the SPA acquires an OIDC token and sends
//          `Authorization: Bearer <jwt>`; the Node entry verifies
//          it against `JWKS_URL` via `bearerJwt`.
export const client = createBaerlyClient({
  baseUrl: "",
  config,
});
