import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Storage,
} from "@baerly/protocol";

/**
 * Idempotently create the `current.json` manifest for a single
 * `(app, tenant, table)` triple. Use this once at process boot in a
 * dev server — production deployments provision manifests via
 * `baerly deploy` instead.
 *
 * Wraps {@link createCurrentJson} with the canonical key shape
 * (`app/<app>/tenant/<tenant>/manifests/<table>/current.json`) and
 * swallows `BaerlyError{code:"Conflict"}` so re-runs are safe. An
 * existing manifest is preserved verbatim — this function never
 * overwrites a populated manifest.
 *
 * @example
 * ```ts
 * import { LocalFsStorage, ensureTable } from "baerly-storage/dev";
 *
 * const storage = new LocalFsStorage({ root: "./.baerly-data" });
 * await ensureTable(storage, { app: "helpdesk", tenant: "demo", table: "tickets" });
 * // …then `createApp({ app: "helpdesk", storage, verifier })`.
 * ```
 */
export const ensureTable = async (
  storage: Storage,
  args: { app: string; tenant: string; table: string },
): Promise<void> => {
  const key = `app/${args.app}/tenant/${args.tenant}/manifests/${args.table}/current.json`;
  try {
    await createCurrentJson(storage, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
    });
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      return;
    }
    throw error;
  }
};
