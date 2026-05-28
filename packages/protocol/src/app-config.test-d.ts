/**
 * Type-level assertions for `BaerlyAppConfig.auth`.
 *
 * Locks the contract that ticket 01 of the graduated-auth redesign
 * establishes: `auth` is required, narrowed to the literal union
 * `"none" | "shared-secret"`, and rejects anything else.
 *
 * Validated by `tsgo --noEmit` (via `pnpm verify`). Not picked up by
 * vitest — the `.test-d.ts` extension is outside the default include
 * glob (see `vitest.config.ts`).
 *
 * Pattern mirrors `collection-api.test-d.ts`: `export const` assertions plus
 * `@ts-expect-error` for negative cases. `noUnusedLocals: true` (see
 * `tsconfig.json`) reports unused locals regardless of the leading-
 * underscore prefix, so the assertion handles are exported. The file
 * is type-only and not re-exported from any barrel.
 */

import { type AuthConfig, type BaerlyAppConfig, defineConfig } from "./app-config.ts";

// --- Positive cases — must typecheck ----------------------------

// `"none"` is accepted.
export const _authNone: BaerlyAppConfig = {
  app: "x",
  tenant: "t",
  target: "cloudflare",
  auth: "none",
  collections: {},
};

// `"shared-secret"` is accepted.
export const _authSharedSecret: BaerlyAppConfig = {
  app: "x",
  tenant: "t",
  target: "cloudflare",
  auth: "shared-secret",
  collections: {},
};

// `defineConfig` preserves the literal `auth` value via `<const C>`.
export const _definedConfig = defineConfig({
  app: "x",
  tenant: "t",
  target: "cloudflare",
  auth: "none",
  collections: {},
} satisfies BaerlyAppConfig);

// `AuthConfig` resolves to the literal union, not `string`.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type _AuthConfigIsLiteralUnion = Expect<Equal<AuthConfig, "none" | "shared-secret">>;

// --- Negative cases — each must fail typecheck -------------------

// Omitting `auth` is a typecheck error. The error is reported at the
// variable declaration (missing property on the assigned literal),
// so `@ts-expect-error` lives there.
// @ts-expect-error — `auth` is required on `BaerlyAppConfig`
export const _missingAuth: BaerlyAppConfig = {
  app: "x",
  tenant: "t",
  target: "cloudflare",
  collections: {},
};

// A random string is rejected — the error fires on the offending
// property value.
export const _wrongAuth: BaerlyAppConfig = {
  app: "x",
  tenant: "t",
  target: "cloudflare",
  // @ts-expect-error — "bearer" is not in AuthConfig
  auth: "bearer",
  collections: {},
};
