import { createBaerlyClient } from "@gusto/baerly-storage/client";
import config from "../../baerly.config.ts";

// Same-origin baseUrl works in both dev and production. With
// `auth: "none"` in baerly.config.ts (the scaffold default), this
// file never sends an `Authorization` header and the adapter pins
// every request to `config.tenant`. When you flip `auth` for
// production, the AGENTS.md "Going to production" recipe shows
// where the token / cookie comes from.
export const client = createBaerlyClient({
  baseUrl: "",
  config,
});
