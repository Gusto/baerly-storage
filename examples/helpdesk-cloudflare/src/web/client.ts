import { createBaerlyClient } from "baerly-storage/client";
import config from "../../baerly.config.ts";

// Same-origin baseUrl works in both dev and production:
//  - Dev:  `baerlyDevAuth` in vite.config.ts injects Authorization
//          server-side; this file never sees the bearer.
//  - Prod: wire CF Access in front of the Worker route; the browser
//          sends `Cf-Access-Jwt-Assertion` as a cookie automatically.
export const client = createBaerlyClient({
  baseUrl: "",
  config,
});
