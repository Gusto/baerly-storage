/**
 * Collection-config schema types + `defineConfig` identity helper.
 *
 * Lives in `@baerly/protocol` (the cross-platform package) so the
 * scaffold's `baerly.config.ts` and the client can reference these
 * types without transitively dragging Node-only server modules
 * (`AsyncLocalStorage` etc.) into their import graph.
 *
 * Runtime helpers that operate on these shapes —
 * `collectionsToMaps`, `validateIndexDefinition`, `validateOrThrow`
 * — stay in `@baerly/server`; they have impl detail that's allowed
 * to depend on Node-only modules.
 *
 * @see ./indexes.ts — `IndexDefinition` type.
 * @see ./schema.ts — `SchemaValidator` / `SchemaIssue` types.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@gusto/baerly-storage/config";
 *
 * export default defineConfig({
 *   app: "tickets",
 *   tenant: "acme",
 *   target: "cloudflare",
 *   collections: {
 *     tickets: {
 *       indexes: [
 *         { name: "by_status", on: "status" },
 *         { name: "by_assignee", on: "assignee" },
 *       ],
 *     },
 *   },
 * });
 * ```
 */

import type { AUTH_CONFIG_VALUES } from "./constants.ts";
import type { IndexDefinition } from "./indexes.ts";
import type { SchemaValidator } from "./schema.ts";

// Cross-platform protocol types re-exported from `@gusto/baerly-storage/config`
// so the scaffold's `baerly.config.ts` and its sibling `types.ts` can
// pull every shape they need from one DOM-pure entry. `DocumentData`
// is the row-shape constraint that scaffolded `interface Note extends
// DocumentData {...}` declarations target; re-exporting here keeps the
// example's typecheck graph from reaching into the server barrel.
export type { DocumentData, DocumentValue } from "./json.ts";

/**
 * One collection's declarative config. Today `indexes` and `schema`
 * are consumed; future tickets add `replica_identity` and lifecycle
 * hooks.
 */
export interface CollectionDefinition {
  /**
   * Secondary indexes declared for this collection. Each declared
   * index produces one zero-byte PUT per commit (when the indexed
   * field is set on the doc) inside the same fence as the log
   * entry and content body. See `./indexes.ts` for the key shape.
   */
  readonly indexes?: ReadonlyArray<IndexDefinition>;
  /**
   * Optional schema for this collection. When set, every server-side
   * `insert` / `update` / `replace` validates the resulting post-image
   * before committing — invalid input throws
   * `BaerlyError{code:"SchemaError"}` carrying a `.issues` array of
   * `{ path, message }` entries.
   *
   * Adapter: StandardSchemaV1 (see `./schema.ts`). Compatible with
   * Zod 3.24+, Valibot 0.36+, ArkType 2.0+ today; any future library
   * implementing the spec works without a code change here.
   *
   * `undefined` means no validation — every write proceeds as today
   * (zero overhead, today's tests untouched).
   *
   * @remarks
   * **`.nullable()` is not supported.** baerly's `DocumentValue` excludes
   * `null` by design (see `packages/protocol/src/json.ts`). `null` is
   * reserved as the JSON-merge-patch (RFC 7386) field-deletion sentinel
   * in `update` patches. Use `.optional()` for absent values.
   *
   * Validation runs on the post-image: `update` and `replace` see the
   * full doc, not just the patch. Failures throw
   * `BaerlyError{ code: "SchemaError", issues: [...] }`.
   */
  readonly schema?: SchemaValidator;
}

/**
 * The full `baerly.config.ts` runtime shape. Re-exported from
 * `baerly-storage` and consumed by the day-1 `npm create baerly`
 * scaffold + the `baerly admin rebuild-index` CLI.
 */
export interface BaerlyConfig {
  /**
   * Per-collection declarations, keyed by collection name. Required
   * (declare `{}` when you have no collections yet) — this keeps the
   * config interface from being structurally empty, which would
   * trigger TypeScript's weak-type check when the adapter accepts
   * the literal as `BaerlyWorkerOptions.config` / `BaerlyNodeOptions.config`.
   */
  readonly collections: Readonly<Record<string, CollectionDefinition>>;
}

/**
 * Auth posture for the deployed app. REQUIRED on `BaerlyAppConfig`.
 *
 * - `"none"`: no header check; every request resolves to
 *   `config.tenant`. Use for local dev, intranet deployments, CLI
 *   tools — contexts where the network seam itself is the trust
 *   boundary. The adapter logs one startup line so the state is not
 *   silent.
 * - `"shared-secret"`: bearer-token check; the adapter reads
 *   `SHARED_SECRET` from the runtime env and pins every request to
 *   `config.tenant`. Module init throws `BaerlyError("InvalidConfig", ...)`
 *   on first `fetch` if the env var is missing/empty.
 *
 * For custom verifiers (Cloudflare Access, JWT, SigV4, …), pass a
 * `Verifier` directly to the adapter factory's `verifier:` option.
 * The factory `verifier:` silently overrides `config.auth` when both
 * are set — this is the "dev default in config, prod override via
 * env" recipe.
 *
 * Field is required on `BaerlyAppConfig`. Omitting it causes both a
 * TypeScript error at `defineConfig({...})` and (defensively) an
 * `InvalidConfig` error at adapter module init.
 *
 * The literal values come from
 * {@link AUTH_CONFIG_VALUES} so the runtime-only consumers (doctor,
 * adapter) share the same source of truth.
 */
export type AuthConfig = (typeof AUTH_CONFIG_VALUES)[number];

/**
 * `BaerlyAppConfig` extends `BaerlyConfig` with scaffold-flavoured
 * deploy metadata (`target`, `domain`, `cloudflareAccess`, etc.).
 *
 * Exposed at `@gusto/baerly-storage/config`. Imported by the
 * `baerly.config.ts` that `npm create baerly` emits, and by anyone
 * who wants IDE/`tsgo` type inference on the full scaffold-aware
 * config shape on top of the runtime `BaerlyConfig.collections` map.
 *
 * One `baerly.config.ts` carries both scaffold metadata (consumed by
 * `baerly deploy` / `baerly doctor`) and the runtime schema
 * (consumed by `Db.create`). The literal-pinned return type of
 * {@link defineConfig} makes `collections` flow through to
 * `Db.create<TConfig>` and `createBaerlyClient<TConfig>`.
 */
export interface BaerlyAppConfig extends BaerlyConfig {
  /** Bucket-prefix for this baerly app. One bucket per app. */
  readonly app: string;
  /**
   * Default tenant pin for `Verifier`s that don't derive a tenant
   * from a claim. Production `Verifier`s (`bearerJwt`,
   * `cloudflareAccess`) ignore this and derive `tenantPrefix` from
   * the request.
   */
  readonly tenant: string;
  /**
   * Deploy target — `"cloudflare"` or `"node"`.
   * Read by `baerly deploy` to dispatch the correct deploy command.
   */
  readonly target: "cloudflare" | "node";
  /**
   * Optional. Custom domain for the deployed service. Cloudflare:
   * wired to the Worker as a route. Node: rendered into the
   * Dockerfile's `EXPOSE` and the emitted readme.
   */
  readonly domain?: string | undefined;
  /**
   * Names of secrets the deployed runtime needs. `baerly deploy`
   * and `baerly doctor` check each against the platform's secret
   * store and warn (deploy) / report (doctor) when missing.
   * Default treatment (when unset) is `["SHARED_SECRET"]` — matches
   * the scaffolder's emitted Verifier wiring.
   */
  readonly requiredSecrets?: readonly string[];
  /**
   * Optional Cloudflare Access app config. When set, the production
   * CF template prefers `cloudflareAccess()` as the `Verifier` and
   * `baerly doctor --target=cloudflare` walks the CF Access app
   * config to confirm the audience tag matches.
   *
   * - `teamDomain` — CF Access team domain, e.g. `"acme"`.
   * - `audienceTag` — Application Audience (AUD) tag from the CF
   *   Access app, 64 lowercase-hex characters.
   */
  readonly cloudflareAccess?: {
    readonly teamDomain: string;
    readonly audienceTag: string;
  };
  /**
   * Optional observability overrides. The templates already
   * read `LOG_LEVEL` from the runtime env; this field is a
   * typed-config alternative for deployments that prefer to pin
   * defaults in source. See `docs/guide/observability.md` for the
   * canonical-line shape and `docs/contributing/conventions/observability.md` for
   * the one-canonical-line-per-unit-of-work rule.
   *
   * - `level` — lowest record level reaching the sink. Falls back
   *   to the `LOG_LEVEL` env var, then to `"info"`.
   */
  readonly observability?: {
    readonly level?: "debug" | "info" | "warn" | "error";
  };
  /**
   * Auth posture. See {@link AuthConfig} for the full per-value
   * semantics, the failure modes, and the "dev default, prod override"
   * recipe. Field is required — omission fails typecheck and (for
   * adapters that didn't supply a `verifier:` override) throws
   * `BaerlyError("InvalidConfig", ...)` at first request.
   */
  readonly auth: AuthConfig;
}

/**
 * Identity helper that pins the config's TypeScript shape so IDEs
 * surface autocomplete and `tsgo --noEmit` catches typos at write
 * time. Returns its input verbatim — no runtime transformation.
 *
 * Two overloads: one for the scaffold-flavoured `BaerlyAppConfig`
 * (the shape `npm create baerly` emits, which carries `app`,
 * `tenant`, `target` deploy metadata) and one for the runtime
 * `BaerlyConfig` shape (just `collections`, used by tests and by
 * apps that wire deploy metadata in some other way). Both preserve
 * the literal shape of `cfg` via `<const C>` so `CollectionNames<C>`
 * and `RowOf<C, N>` resolve to literal unions.
 */
export function defineConfig<const C extends BaerlyAppConfig>(cfg: C): C;
export function defineConfig<const C extends BaerlyConfig>(cfg: C): C;
export function defineConfig<const C extends BaerlyConfig>(cfg: C): C {
  return cfg;
}

/**
 * Sentinel `BaerlyConfig` used as the default `TConfig` parameter
 * by consumers (`Db<TConfig>`, `BaerlyClient<TConfig>`). Setting
 * `collections` to `Record<string, CollectionDefinition>` makes
 * `CollectionNames<UnboundConfig>` widen to `string`, so the single
 * typed accessor `db.collection<N extends CollectionNames<TConfig>>(name: N)`
 * still resolves for kernel-internal paths (which carry no bound
 * config) — those callers see `name: string` and the row type
 * defaults to `DocumentData` via {@link RowOf}'s `Record<string, unknown>`
 * fallback. Consumers who bind a config via {@link defineConfig}
 * narrow `CollectionNames<TConfig>` to a literal union and lose the
 * string-typo accepting behaviour, which is the design intent.
 */
export type UnboundConfig = { readonly collections: Record<string, CollectionDefinition> };

/**
 * Set of declared collection names on a `BaerlyConfig`, as a string
 * union. Resolves to `never` when no `collections` are declared
 * (notably for `UnboundConfig`), which the typed `Db` / client
 * overloads use to disable narrowing for unbound consumers.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   collections: {
 *     tickets: { schema: TicketSchema },
 *     audits: {},
 *   },
 * });
 * type Names = CollectionNames<typeof config>; // "tickets" | "audits"
 * ```
 */
export type CollectionNames<C extends BaerlyConfig> = C extends {
  readonly collections: infer Cs;
}
  ? Extract<keyof Cs, string>
  : never;

/**
 * Row type for collection `N` on config `C`. Resolves to the
 * `StandardSchemaV1` output type of `C["collections"][N]["schema"]`
 * when one is declared; otherwise falls back to
 * `Record<string, unknown>`.
 *
 * The fallback is intentionally wider than the protocol's
 * `DocumentData`. Downstream call sites that need
 * `DocumentData` (e.g. `Collection<T extends DocumentData>`)
 * apply the intersection at their own seam — keeping that
 * constraint local to the consumer keeps THIS file independent of
 * `@baerly/protocol/src/json.ts`.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   collections: {
 *     tickets: { schema: TicketSchema },
 *     audits: {},
 *   },
 * });
 * type Ticket = RowOf<typeof config, "tickets">; // z.infer<typeof TicketSchema>
 * type Audit = RowOf<typeof config, "audits">;   // Record<string, unknown>
 * ```
 */
export type RowOf<C extends BaerlyConfig, N extends CollectionNames<C>> = C extends {
  readonly collections: infer Cs;
}
  ? N extends keyof Cs
    ? Cs[N] extends { readonly schema: infer S }
      ? S extends SchemaValidator<unknown, infer Out>
        ? Out
        : Record<string, unknown>
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;
