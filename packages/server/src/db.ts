/* eslint-disable no-underscore-dangle -- `_raw` is the locked public-symbol
   name for the Phase-3 Storage escape hatch; mirrors the Phase-4 `Db._raw`
   declaration in `@baerly/protocol/src/db.ts` and is marked `@internal`. */

import { MPS3Error } from "@baerly/protocol";
import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "@baerly/protocol";

/**
 * Physical-key prefix for a `(app, tenant)` pair. Trailing slash is
 * part of the prefix so a caller's `list("")` resolves to
 * `list("app/<app>/tenant/<tenant>/")` and cannot enumerate a sibling
 * tenant whose name shares a prefix.
 */
const physicalPrefixFor = (app: string, tenant: string): string => `app/${app}/tenant/${tenant}/`;

/**
 * Phase-3 escape hatch: a Storage-shaped surface scoped to one
 * `(app, tenant)` pair. Keys callers see are **logical** (e.g.
 * `"docs/123"`); the wrapper composes
 * `app/<app>/tenant/<tenant>/<key>` before touching the underlying
 * `Storage`, and strips the prefix back off when yielding from
 * `list`.
 *
 * Bypasses every higher-level invariant: no `LogEntry` emit, no CAS
 * on `current.json`, no schema check. Phase 4 adds the
 * LogEntry-based `RawApi` (declared in
 * `@baerly/protocol/src/db.ts`) on top, likely as a separate `_log`
 * field on `Db`.
 *
 * @internal — public symbol, but the table API (Phase 4) is the
 *             recommended surface for app code.
 */
export interface RawStorageApi {
  get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null>;
  put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult>;
  delete(key: string, opts?: { signal?: AbortSignal }): Promise<void>;
  list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry>;
}

/**
 * Phase-3 runtime entry point. One `Db` per `(app, tenant)` request.
 *
 * Construct via {@link Db.create} — the constructor is private so
 * callers don't accidentally bypass validation.
 *
 * @example
 * ```ts
 * import { Db } from "@baerly/server";
 * import { MemoryStorage } from "@baerly/protocol";
 *
 * const db = Db.create({
 *   storage: new MemoryStorage(),
 *   app: "tickets",
 *   tenant: "acme-co",
 * });
 *
 * await db._raw.put("docs/123", new TextEncoder().encode("hi"));
 * const got = await db._raw.get("docs/123");
 * ```
 */
export class Db {
  readonly app: string;
  readonly tenant: string;
  /** @internal — Storage-shaped escape hatch; prefer the table API. */
  readonly _raw: RawStorageApi;

  private constructor(app: string, tenant: string, storage: Storage) {
    this.app = app;
    this.tenant = tenant;
    this._raw = makeRawStorageApi(app, tenant, storage);
  }

  /**
   * Build a tenant-scoped `Db`. Throws
   * `MPS3Error{code:"InvalidConfig"}` if either `app` or `tenant`
   * is empty or contains `/` (the segment separator).
   *
   * @throws MPS3Error code="InvalidConfig" when `app` or `tenant` is
   *   empty or contains `/`.
   *
   * @example
   * ```ts
   * const db = Db.create({ storage, app: "tickets", tenant: "acme" });
   * ```
   */
  static create(config: { storage: Storage; app: string; tenant: string }): Db {
    const { storage, app, tenant } = config;
    if (app.length === 0 || tenant.length === 0) {
      throw new MPS3Error(
        "InvalidConfig",
        `Db.create requires non-empty app and tenant (got app=${JSON.stringify(app)}, tenant=${JSON.stringify(tenant)})`,
      );
    }
    if (app.includes("/") || tenant.includes("/")) {
      throw new MPS3Error(
        "InvalidConfig",
        `Db.create: "/" is reserved as the key-segment separator (got app=${JSON.stringify(app)}, tenant=${JSON.stringify(tenant)})`,
      );
    }
    return new Db(app, tenant, storage);
  }
}

const makeRawStorageApi = (app: string, tenant: string, storage: Storage): RawStorageApi => {
  const prefix = physicalPrefixFor(app, tenant);
  const toPhysical = (logical: string): string => `${prefix}${logical}`;
  const fromPhysical = (physical: string): string => {
    if (!physical.startsWith(prefix)) {
      // Underlying storage yielded a key outside our tenant's
      // prefix. Unreachable under a correct `Storage` impl (we
      // asked it to list our prefix), so an `Internal` invariant
      // violation is the right shape.
      throw new MPS3Error(
        "Internal",
        `Db._raw.list: storage yielded key ${JSON.stringify(physical)} outside expected prefix ${JSON.stringify(prefix)}`,
      );
    }
    return physical.slice(prefix.length);
  };

  return {
    get: (key, opts) => storage.get(toPhysical(key), opts),
    put: (key, body, opts) => storage.put(toPhysical(key), body, opts),
    delete: (key, opts) => storage.delete(toPhysical(key), opts),
    list: async function* (logicalPrefix, opts) {
      const passOpts: {
        startAfter?: string;
        maxKeys?: number;
        signal?: AbortSignal;
      } = {};
      if (opts?.startAfter !== undefined) {
        // The cursor must also be rewritten to physical — otherwise
        // the underlying storage compares a logical-keyed cursor
        // against physical-keyed entries and the cursor is
        // effectively ignored.
        passOpts.startAfter = toPhysical(opts.startAfter);
      }
      if (opts?.maxKeys !== undefined) passOpts.maxKeys = opts.maxKeys;
      if (opts?.signal !== undefined) passOpts.signal = opts.signal;
      for await (const entry of storage.list(toPhysical(logicalPrefix), passOpts)) {
        yield { ...entry, key: fromPhysical(entry.key) };
      }
    },
  };
};
