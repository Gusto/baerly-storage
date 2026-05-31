import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Storage,
} from "@baerly/protocol";

/**
 * Optional pre-warm: idempotently create the `current.json` manifest
 * for a single `(app, tenant, table)` triple. The kernel auto-creates
 * this manifest on the first commit anyway (see `Db.create` and
 * `Writer.commit`), so calling `ensureTable` is **not required** for
 * correctness — it's a one-Class-A-PUT optimization for callers that
 * want the manifest in place before the first request lands (seed
 * scripts, deploy-time provisioning, CI fixtures that snapshot the
 * bucket between phases, etc.).
 *
 * Wraps {@link createCurrentJson} with the canonical key shape
 * (`app/<app>/tenant/<tenant>/manifests/<table>/current.json`) and
 * swallows `BaerlyError{code:"Conflict"}` so re-runs are safe. An
 * existing manifest is preserved verbatim — this function never
 * overwrites a populated manifest. The seed shape matches the
 * kernel's auto-create exactly, so a pre-warm and an
 * auto-provisioned bucket are byte-identical.
 *
 * @example
 * ```ts
 * import { LocalFsStorage, ensureTable } from "@gusto/baerly-storage/dev";
 *
 * const storage = new LocalFsStorage({ root: "./.baerly-data" });
 * // Pre-warm so the first request doesn't pay the bootstrap PUT.
 * await ensureTable(storage, { app: "helpdesk", tenant: "demo", table: "tickets" });
 * // …then `baerlyNode({ config, storage, verifier })`.
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
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      return;
    }
    throw error;
  }
};
