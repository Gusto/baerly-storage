import { createBaerlyClient } from "@gusto/baerly-storage/client";
import { createBaerlyReact } from "@gusto/baerly-storage/client/react";
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

// The bound React surface. `createBaerlyReact<typeof config>()` pins
// every hook to your collections, so inside a `useQuery` /
// `useMutation` callback `c.collection("notes")` infers the `Note`
// row type — no casts. Import these hooks from this module (not from
// the package) so they stay bound.
export const { BaerlyProvider, useQuery, useMutation } = createBaerlyReact<typeof config>();
