import { BaerlyError, probeCas, type Storage } from "@baerly/protocol";

/** Options for {@link assertStorageReachable}. */
export interface AssertStorageReachableOptions {
  /** Key prefix for the throwaway probe sentinels. Default `""`. */
  keyPrefix?: string;
  signal?: AbortSignal;
}

/**
 * Boot-time readiness check: confirm a live `Storage` backend is both
 * reachable and honours the conditional writes the protocol depends on.
 * `await` it at startup (or from a `/readyz` handler wired to your
 * platform's readiness probe) to fail closed on a misconfigured backend —
 * an unreachable or non-existent bucket, denied/missing credentials (wrong
 * endpoint/region), or an S3-compatible store that silently ignores
 * `If-Match`/`If-None-Match` (the CAS the protocol depends on) — instead
 * of discovering it on the first user write. It cannot detect a
 * wrong-but-writable bucket: a typo to another reachable bucket you own
 * boots clean, because the probe can only tell that *a* bucket is reachable
 * and CAS-correct, not that it is the *intended* one. This complements
 * `resolveStorageFromEnv`, which catches a *missing* configuration:
 * `assertStorageReachable` additionally catches an
 * unreachable/access-denied/CAS-broken backend at boot instead of on the
 * first write.
 *
 * Opt-in by design: it performs a handful of live round-trips (writes and
 * deletes throwaway sentinels under `keyPrefix`), so it is never run
 * automatically on every boot. Reuses the same `probeCas` machinery as
 * `baerly doctor --bucket`.
 *
 * @throws BaerlyError `NetworkError` if the backend is unreachable, or
 * `InvalidConfig` if it is reachable but fails a required CAS check.
 *
 * @example
 * ```ts
 * const { storage, label } = resolveStorageFromEnv();
 * await assertStorageReachable(storage); // throws before we serve traffic
 * console.log(`[baerly] storage=${label} (reachable)`);
 * ```
 */
export const assertStorageReachable = async (
  storage: Storage,
  opts?: AssertStorageReachableOptions,
): Promise<void> => {
  let result;
  try {
    result = await probeCas(storage, opts);
  } catch (error) {
    throw new BaerlyError(
      "NetworkError",
      "Storage readiness check failed: the backend could not be reached. Verify the bucket name, " +
        `region/endpoint, and credentials. Cause: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (!result.ok) {
    const failed = result.checks
      .filter((c) => !c.ok)
      .map((c) => `  - ${c.name}: ${c.detail}`)
      .join("\n");
    throw new BaerlyError(
      "InvalidConfig",
      "Storage readiness check failed — the backend does not honour the conditional writes baerly " +
        `requires (data corruption risk). Use a fully S3-conditional-compatible store:\n${failed}`,
    );
  }
};
