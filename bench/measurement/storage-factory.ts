/**
 * Per-attempt storage provisioning with **exact** cleanup authority.
 *
 * A factory hands back one fresh backend plus the narrowest possible authority
 * to remove it: a single in-memory instance, the single `mkdtemp` directory it
 * created, or an explicit list of known keys. Nothing here can delete a bucket,
 * a parent directory, or a prefix — that restriction is the point of the
 * module, not an implementation detail.
 *
 * Node-only: it reads `node:fs/promises`, `node:os`, and `node:path`. The
 * journal module it composes with stays runtime-import-free.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MemoryStorage, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import {
  type AttemptId,
  type StorageJournal,
  describeThrown,
  wrapJournaledStorage,
} from "./storage-journal.ts";

const DEFAULT_DIRECTORY_PREFIX = "baerly-measurement-";

export type CleanupAuthority =
  | { readonly kind: "memory-instance"; readonly lease_id: string }
  | { readonly kind: "exact-directory"; readonly absolute_path: string }
  | { readonly kind: "exact-keys"; readonly keys: readonly string[] };

export interface CleanupFailure {
  readonly target: string;
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export interface CleanupReport {
  readonly status: "clean" | "partial" | "failed";
  readonly authority: CleanupAuthority;
  readonly attempted_targets: readonly string[];
  readonly cleaned_targets: readonly string[];
  readonly failures: readonly CleanupFailure[];
}

export interface StorageLease {
  readonly attempt_id: AttemptId;
  readonly factory_id: string;
  readonly backend: string;
  readonly namespace_id: string;
  readonly storage: Storage;
  readonly journal: StorageJournal;
  readonly cleanup_authority: CleanupAuthority;
  lifecycle(): "active" | "cleaned";
  cleanup(): Promise<CleanupReport>;
}

export interface ProvisioningFailure {
  readonly stage: "provision";
  readonly factory_id: string;
  readonly backend: string;
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export type StorageFactoryCreateResult =
  | { readonly status: "created"; readonly lease: StorageLease }
  | { readonly status: "failed"; readonly failure: ProvisioningFailure };

export interface StorageFactory {
  readonly id: string;
  readonly backend: string;
  create(input: { readonly attemptId: AttemptId }): Promise<StorageFactoryCreateResult>;
}

export interface ExactKeyCleanup {
  readonly authority: CleanupAuthority;
  cleanup(): Promise<CleanupReport>;
}

export type WithStorageLeaseResult<T> =
  | { readonly status: "provision_failed"; readonly failure: ProvisioningFailure }
  | {
      readonly status: "returned";
      readonly value: T;
      readonly cleanup: CleanupReport;
      readonly pending_operations_at_cleanup: number;
    }
  | {
      readonly status: "threw";
      readonly error: unknown;
      readonly cleanup: CleanupReport;
      readonly pending_operations_at_cleanup: number;
    };

/**
 * True iff `root` is a direct child of `parent` whose basename carries
 * `prefix`. Exported and separately tested because inside the local-fs cleanup
 * closure the condition is unreachable by construction — `mkdtemp(join(parent,
 * prefix))` guarantees it — so the refusal branch would otherwise ship with no
 * coverage at all.
 *
 * `parent` is expected already `resolve`d and must NOT be `realpath`ed:
 * `os.tmpdir()` is a symlink on macOS, and resolving one side of the comparison
 * but not the other rejects every real root. `startsWith` is a case-SENSITIVE
 * comparison on purpose — `mkdtemp` appends a mixed-case suffix on macOS, and
 * lowercasing either side would be the bug, not the fix.
 */
export const isWithinCleanupAuthority = (input: {
  readonly root: string;
  readonly parent: string;
  readonly prefix: string;
}): boolean =>
  dirname(input.root) === input.parent && basename(input.root).startsWith(input.prefix);

// Process-monotone so no two leases in one process can collide, even across
// two factory instances of the same backend.
let leaseCounter = 0;
const nextLeaseId = (backend: string): string => {
  leaseCounter += 1;
  return `${backend}-lease-${leaseCounter}`;
};

const reportStatus = (
  cleaned: readonly string[],
  failures: readonly CleanupFailure[],
): CleanupReport["status"] => {
  if (failures.length === 0) {
    return "clean";
  }
  return cleaned.length === 0 ? "failed" : "partial";
};

const buildReport = (
  authority: CleanupAuthority,
  attempted: readonly string[],
  cleaned: readonly string[],
  failures: readonly CleanupFailure[],
): CleanupReport =>
  Object.freeze<CleanupReport>({
    status: reportStatus(cleaned, failures),
    authority,
    attempted_targets: Object.freeze([...attempted]),
    cleaned_targets: Object.freeze([...cleaned]),
    failures: Object.freeze([...failures]),
  });

const toCleanupFailure = (target: string, error: unknown): CleanupFailure => {
  const described = describeThrown(error);
  return {
    target,
    name: described.name,
    ...(described.code !== undefined && { code: described.code }),
    message: described.message,
  };
};

const toProvisioningFailure = (
  factoryId: string,
  backend: string,
  error: unknown,
): ProvisioningFailure => {
  const described = describeThrown(error);
  return {
    stage: "provision",
    factory_id: factoryId,
    backend,
    name: described.name,
    ...(described.code !== undefined && { code: described.code }),
    message: described.message,
  };
};

/**
 * Delete an explicit, sorted, de-duplicated key list. Never a prefix, never a
 * LIST, and never short-circuited: a failure on one key does not skip the rest.
 * Pass the **inner** (unwrapped) storage so teardown deletes stay out of the
 * attempt's operation journal.
 */
export const createExactKeyCleanup = (input: {
  readonly storage: Storage;
  readonly keys: readonly string[];
}): ExactKeyCleanup => {
  const keys = Object.freeze([...new Set(input.keys)].toSorted());
  const authority: CleanupAuthority = { kind: "exact-keys", keys };
  let memoized: CleanupReport | undefined;
  return {
    authority,
    cleanup: async (): Promise<CleanupReport> => {
      if (memoized !== undefined) {
        return memoized;
      }
      const cleaned: string[] = [];
      const failures: CleanupFailure[] = [];
      for (const key of keys) {
        try {
          await input.storage.delete(key);
          cleaned.push(key);
        } catch (error: unknown) {
          failures.push(toCleanupFailure(key, error));
        }
      }
      memoized = buildReport(authority, keys, cleaned, failures);
      return memoized;
    },
  };
};

const makeLease = (input: {
  readonly attemptId: AttemptId;
  readonly factoryId: string;
  readonly backend: string;
  readonly namespaceId: string;
  readonly storage: Storage;
  readonly authority: CleanupAuthority;
  readonly runCleanup: () => Promise<{
    readonly cleaned: readonly string[];
    readonly failures: readonly CleanupFailure[];
    readonly attempted: readonly string[];
  }>;
}): StorageLease => {
  const journaled = wrapJournaledStorage({
    attemptId: input.attemptId,
    storage: input.storage,
  });
  let lifecycle: "active" | "cleaned" = "active";
  let memoized: CleanupReport | undefined;
  return {
    attempt_id: input.attemptId,
    factory_id: input.factoryId,
    backend: input.backend,
    namespace_id: input.namespaceId,
    storage: journaled.storage,
    journal: journaled.journal,
    cleanup_authority: input.authority,
    lifecycle: () => lifecycle,
    cleanup: async (): Promise<CleanupReport> => {
      if (memoized !== undefined) {
        return memoized;
      }
      lifecycle = "cleaned";
      const outcome = await input.runCleanup();
      memoized = buildReport(input.authority, outcome.attempted, outcome.cleaned, outcome.failures);
      return memoized;
    },
  };
};

/**
 * One isolated {@link MemoryStorage} per attempt. Cleanup empties that
 * instance — the lease and the journal closure both retain a reference to it,
 * so "drop the reference" was never something this factory could do, and a
 * report of `clean` for a backend that still holds every byte is exactly the
 * fabricated authority this module exists to rule out.
 */
export const createMemoryStorageFactory = (): StorageFactory => {
  const id = "measurement.memory/v1";
  const backend = "memory";
  return {
    id,
    backend,
    create: async ({ attemptId }): Promise<StorageFactoryCreateResult> => {
      try {
        const leaseId = nextLeaseId(backend);
        const instance = new MemoryStorage();
        return {
          status: "created",
          lease: makeLease({
            attemptId,
            factoryId: id,
            backend,
            namespaceId: leaseId,
            storage: instance,
            authority: { kind: "memory-instance", lease_id: leaseId },
            runCleanup: async () => {
              instance._clear();
              return { attempted: [leaseId], cleaned: [leaseId], failures: [] };
            },
          }),
        };
      } catch (error: unknown) {
        return { status: "failed", failure: toProvisioningFailure(id, backend, error) };
      }
    },
  };
};

/**
 * One `mkdtemp` root per attempt under the selected temp parent. Cleanup
 * removes **only** that root, and only after {@link isWithinCleanupAuthority}
 * re-derives that it is a direct child of the selected parent carrying the
 * requested prefix.
 */
export const createLocalFsStorageFactory = (input?: {
  readonly temp_parent?: string;
  readonly directory_prefix?: string;
}): StorageFactory => {
  const id = "measurement.local-fs/v1";
  const backend = "local-fs";
  const parent = resolve(input?.temp_parent ?? tmpdir());
  const prefix = input?.directory_prefix ?? DEFAULT_DIRECTORY_PREFIX;
  return {
    id,
    backend,
    create: async ({ attemptId }): Promise<StorageFactoryCreateResult> => {
      let root: string;
      try {
        root = await mkdtemp(join(parent, prefix));
      } catch (error: unknown) {
        return { status: "failed", failure: toProvisioningFailure(id, backend, error) };
      }
      return {
        status: "created",
        lease: makeLease({
          attemptId,
          factoryId: id,
          backend,
          namespaceId: root,
          storage: new LocalFsStorage({ root }),
          authority: { kind: "exact-directory", absolute_path: root },
          runCleanup: async () => {
            if (!isWithinCleanupAuthority({ root, parent, prefix })) {
              return {
                attempted: [root],
                cleaned: [],
                failures: [
                  {
                    target: root,
                    name: "CleanupAuthorityError",
                    code: "OutOfAuthority",
                    message:
                      `refusing to remove ${root}: not a direct child of ${parent} ` +
                      `with prefix ${prefix}`,
                  },
                ],
              };
            }
            try {
              await rm(root, { recursive: true, force: true });
              return { attempted: [root], cleaned: [root], failures: [] };
            } catch (error: unknown) {
              return {
                attempted: [root],
                cleaned: [],
                failures: [toCleanupFailure(root, error)],
              };
            }
          },
        }),
      };
    },
  };
};

/**
 * Provision, run, then always clean up. Provisioning failure short-circuits
 * before `work` runs. A throw from `work` is returned **by identity** alongside
 * the cleanup report — cleanup never replaces or masks it.
 *
 * `pending_operations_at_cleanup` is sampled from the journal BEFORE cleanup
 * runs. A non-zero value means `work` returned or threw while one of its own
 * storage operations was still in flight, so the backend may have been torn out
 * from under it: the local-fs factory `rm -rf`s the root, and the memory factory
 * drops the only reference. The runner does NOT throw on this — that would mask
 * `work`'s own error, which is the one thing the caller most needs — and it does
 * NOT wait, because there is no safe general way to wait for an operation the
 * caller abandoned. It reports. A caller seeing a non-zero value must treat the
 * result as invalid.
 */
export const withStorageLease = async <T>(
  factory: StorageFactory,
  attemptId: AttemptId,
  work: (lease: StorageLease) => Promise<T>,
): Promise<WithStorageLeaseResult<T>> => {
  const created = await factory.create({ attemptId });
  if (created.status === "failed") {
    return { status: "provision_failed", failure: created.failure };
  }
  const { lease } = created;
  const settled = await work(lease).then(
    (value: T) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  const pendingAtCleanup = lease.journal.pendingOperationCount();
  // Settled, not bare-awaited. `work`'s error is the one thing the caller most
  // needs, and the doc above promises it comes back by identity — but
  // `withStorageLease` takes an ARBITRARY factory (the test suite supplies one
  // whose cleanup fails), so a lease whose `cleanup()` rejects rather than
  // returning a `failed` report would reject this whole call and discard
  // `work`'s exception. Convert the rejection into the `failed` report the
  // contract already has a shape for.
  const cleanup = await lease.cleanup().then(
    (report: CleanupReport) => report,
    (error: unknown): CleanupReport =>
      buildReport(lease.cleanup_authority, [], [], [toCleanupFailure(lease.namespace_id, error)]),
  );
  return settled.ok
    ? {
        status: "returned",
        value: settled.value,
        cleanup,
        pending_operations_at_cleanup: pendingAtCleanup,
      }
    : {
        status: "threw",
        error: settled.error,
        cleanup,
        pending_operations_at_cleanup: pendingAtCleanup,
      };
};
