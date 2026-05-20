/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Table<T>`
   declaration); the synthetic seed populates it directly. */

/**
 * End-to-end test for `baerly copy` over `memory` + `local-fs`. Calls
 * `runCopy` programmatically so we can assert on the integer exit
 * code without `process.exit` killing vitest. The `node-minio`
 * variant lives at `tests/integration/baerly-copy-minio.test.ts` and
 * is gated on `MINIO=1`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  readCurrentJson,
  resetMemoryStorage,
  type DocumentData,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Db } from "@baerly/server";
import { ServerWriter } from "@baerly/server/_internal/testing";
import { runCopy } from "./copy.ts";

interface Doc extends DocumentData {
  _id: string;
  title: string;
  status: "open" | "closed";
}

const APP = "app";
const TENANT = "t";
const COLL = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

interface VariantContext {
  src: Storage;
  dst: Storage;
  srcUri: string;
  dstUri: string;
  cleanup?: () => Promise<void>;
}

interface Variant {
  label: "memory" | "local-fs";
  setup: () => Promise<VariantContext>;
}

const VARIANTS: readonly Variant[] = [
  {
    label: "memory",
    setup: async () => {
      // memory:// uses `getOrCreateMemoryStorageForBucket` keyed on
      // bucket name; reset before each variant run so a stale
      // copy-src / copy-dst from a previous test doesn't leak in.
      resetMemoryStorage();
      return await Promise.resolve({
        src: getOrCreateMemoryStorageForBucket("copy-src"),
        dst: getOrCreateMemoryStorageForBucket("copy-dst"),
        srcUri: "memory://copy-src",
        dstUri: "memory://copy-dst",
      });
    },
  },
  {
    label: "local-fs",
    setup: async () => {
      const s = await mkdtemp(join(tmpdir(), "baerly-copy-src-"));
      const d = await mkdtemp(join(tmpdir(), "baerly-copy-dst-"));
      return {
        src: new LocalFsStorage({ root: s }),
        dst: new LocalFsStorage({ root: d }),
        srcUri: `file://${s}`,
        dstUri: `file://${d}`,
        cleanup: async () => {
          await rm(s, { recursive: true, force: true }).catch(() => {});
          await rm(d, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  },
];

describe("baerly copy", () => {
  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      let cleanup: (() => Promise<void>) | undefined;
      afterEach(async () => {
        if (cleanup) {
          await cleanup();
        }
        cleanup = undefined;
      });

      const seed = async (storage: Storage): Promise<void> => {
        await createCurrentJson(storage, CURRENT_JSON_KEY, {
          schema_version: CURRENT_JSON_SCHEMA_VERSION,
          snapshot: null,
          next_seq: 0,
          log_seq_start: 0,
          writer_fence: { epoch: 0, owner: "copy-test", claimed_at: "" },
        });
      };

      test("preserves find() parity", async () => {
        const ctx = await variant.setup();
        cleanup = ctx.cleanup;
        await seed(ctx.src);
        const w = new ServerWriter({
          storage: ctx.src,
          currentJsonKey: CURRENT_JSON_KEY,
        });
        const N = 50;
        await w.commitBatch(
          Array.from({ length: N }, (_, i) => ({
            op: "I" as const,
            collection: COLL,
            docId: `doc-${i}`,
            body: {
              _id: `doc-${i}`,
              title: `t-${i}`,
              status: i % 2 ? "closed" : "open",
            } as Doc,
          })),
        );
        const post = await readCurrentJson(ctx.src, CURRENT_JSON_KEY);
        expect(post).not.toBeNull();
        const code = await runCopy([
          `--from=${ctx.srcUri}`,
          `--from-snapshot=${CURRENT_JSON_KEY}@${post!.etag}`,
          `--to=${ctx.dstUri}`,
        ]);
        expect(code).toBe(0);

        const sorted = <T extends { _id: string }>(rs: readonly T[]): T[] =>
          [...rs].toSorted((a, b) => {
            if (a._id < b._id) {
              return -1;
            }
            if (a._id > b._id) {
              return 1;
            }
            return 0;
          });
        const srcRows = await Db.create({ storage: ctx.src, app: APP, tenant: TENANT })
          .table<Doc>(COLL)
          .where({})
          .all();
        const dstRows = await Db.create({ storage: ctx.dst, app: APP, tenant: TENANT })
          .table<Doc>(COLL)
          .where({})
          .all();
        expect(sorted(dstRows)).toEqual(sorted(srcRows));
        expect(dstRows.length).toBe(N);
      });

      test("rejects an advanced cursor (exit 3)", async () => {
        const ctx = await variant.setup();
        cleanup = ctx.cleanup;
        await seed(ctx.src);
        const pre = await readCurrentJson(ctx.src, CURRENT_JSON_KEY);
        expect(pre).not.toBeNull();
        await new ServerWriter({
          storage: ctx.src,
          currentJsonKey: CURRENT_JSON_KEY,
        }).commit({ op: "I", collection: COLL, docId: "x", body: { _id: "x" } });
        const code = await runCopy([
          `--from=${ctx.srcUri}`,
          `--from-snapshot=${CURRENT_JSON_KEY}@${pre!.etag}`,
          `--to=${ctx.dstUri}`,
        ]);
        expect(code).toBe(3);
      });

      test("refuses a second copy onto a populated target (exit 3)", async () => {
        const ctx = await variant.setup();
        cleanup = ctx.cleanup;
        await seed(ctx.src);
        await new ServerWriter({
          storage: ctx.src,
          currentJsonKey: CURRENT_JSON_KEY,
        }).commit({
          op: "I",
          collection: COLL,
          docId: "only",
          body: { _id: "only", title: "x", status: "open" } as Doc,
        });
        const post = await readCurrentJson(ctx.src, CURRENT_JSON_KEY);
        const args = [
          `--from=${ctx.srcUri}`,
          `--from-snapshot=${CURRENT_JSON_KEY}@${post!.etag}`,
          `--to=${ctx.dstUri}`,
        ];
        await expect(runCopy(args)).resolves.toBe(0);
        // Second copy: target current.json now exists; createCurrentJson
        // throws Conflict → exit 3.
        await expect(runCopy(args)).resolves.toBe(3);
      });

      test("rejects a malformed cursor (exit 1)", async () => {
        const ctx = await variant.setup();
        cleanup = ctx.cleanup;
        const code = await runCopy([
          `--from=${ctx.srcUri}`,
          `--from-snapshot=missing-at-sign`,
          `--to=${ctx.dstUri}`,
        ]);
        expect(code).toBe(1);
      });

      test("rejects unknown flag (exit 1)", async () => {
        const ctx = await variant.setup();
        cleanup = ctx.cleanup;
        const code = await runCopy([
          `--from=${ctx.srcUri}`,
          `--from-snapshot=${CURRENT_JSON_KEY}@etag`,
          `--to=${ctx.dstUri}`,
          `--unknown=x`,
        ]);
        expect(code).toBe(1);
      });

      test("--json emits structured envelopes on success and failure", async () => {
        const ctx = await variant.setup();
        cleanup = ctx.cleanup;
        await seed(ctx.src);
        await new ServerWriter({
          storage: ctx.src,
          currentJsonKey: CURRENT_JSON_KEY,
        }).commit({
          op: "I",
          collection: COLL,
          docId: "only",
          body: { _id: "only", title: "x", status: "open" } as Doc,
        });
        const post = await readCurrentJson(ctx.src, CURRENT_JSON_KEY);

        // Success: stdout receives one `{result:{command:"copy",status:"ok"}}` line.
        const stdoutOk = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderrOk = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const ok = await runCopy([
            `--from=${ctx.srcUri}`,
            `--from-snapshot=${CURRENT_JSON_KEY}@${post!.etag}`,
            `--to=${ctx.dstUri}`,
            `--json`,
          ]);
          expect(ok).toBe(0);
          const okWrites = stdoutOk.mock.calls.map(([c]) => String(c)).join("");
          expect(stderrOk).not.toHaveBeenCalled();
          expect(JSON.parse(okWrites.trim())).toEqual({
            result: { command: "copy", status: "ok" },
          });
        } finally {
          stdoutOk.mockRestore();
          stderrOk.mockRestore();
        }

        // Failure (malformed cursor → InvalidConfig → exit 1): stderr
        // receives one `{error:{code,message,command}}` line; stdout stays
        // silent.
        const stdoutErr = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderrErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const bad = await runCopy([
            `--from=${ctx.srcUri}`,
            `--from-snapshot=missing-at-sign`,
            `--to=${ctx.dstUri}`,
            `--json`,
          ]);
          expect(bad).toBe(1);
          const errWrites = stderrErr.mock.calls.map(([c]) => String(c)).join("");
          expect(stdoutErr).not.toHaveBeenCalled();
          const parsed = JSON.parse(errWrites.trim()) as {
            error: { code: string; message: string; command: string };
          };
          expect(parsed.error.code).toBe("InvalidConfig");
          expect(parsed.error.command).toBe("copy");
          expect(parsed.error.message).toContain("cursor");
        } finally {
          stdoutErr.mockRestore();
          stderrErr.mockRestore();
        }
      });
    });
  }
});
