import { BaerlyError, type Storage } from "@baerly/protocol";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import type { BaerlyEnv, BaerlyWorkerOptions } from "./worker.ts";

/**
 * Resolve the request-time {@link Storage} for a Worker.
 *
 * Precedence: an explicitly injected `options.storage` (the S3-over-HTTP
 * / cross-account path) wins; otherwise the same-account R2 binding
 * `env.BUCKET`. With neither, fail closed with `InvalidConfig` rather
 * than silently serving nothing.
 */
export function resolveWorkerStorage(
  options: Pick<BaerlyWorkerOptions, "storage">,
  env: Pick<BaerlyEnv, "BUCKET">,
): Storage {
  if (options.storage) {
    return options.storage;
  }
  if (!env.BUCKET) {
    throw new BaerlyError(
      "InvalidConfig",
      "baerlyWorker: no storage available. Bind an R2 bucket as `BUCKET`, " +
        "or pass `storage` in the factory options — e.g. " +
        'new S3HttpStorage(...) from "@gusto/baerly-storage/s3".',
    );
  }
  return r2BindingStorage(env.BUCKET);
}
