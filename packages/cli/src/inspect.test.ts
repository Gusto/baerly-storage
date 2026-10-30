/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + inspect CLI. */

/**
 * CLI test for `baerly inspect`.
 *
 * Provisions a fresh `LocalFsStorage` collection with N rows, runs
 * `runInspect` programmatically, and asserts the JSON envelope's
 * row count / tail_hint / log_seq_start. A second test injects an
 * orphan snapshot file and asserts `status: "error"` with the
 * orphan path enumerated in `errors`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  type Storage,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { runInspect } from "./inspect.ts";
import { captureStream } from "./_internal/testing.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "inspect-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

describe("baerly inspect", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-inspect-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reports row count + stored tail_hint + discovered tail + log_seq_start in JSON envelope", async () => {
    await provision(storage);
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "first", status: "open" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", title: "second", status: "closed" },
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        command: string;
        currentJsonKey: string;
        materialised_rows: number;
        tail_hint: number;
        discovered_tail: number;
        log_seq_start: number;
        live_log_tail: number;
        snapshot: string | null;
        snapshot_bytes: number;
        snapshot_rows: number;
        status: string;
        errors: string[];
      };
    };
    expect(envelope.result.command).toBe("inspect");
    expect(envelope.result.currentJsonKey).toBe(CURRENT_JSON_KEY);
    expect(envelope.result.materialised_rows).toBe(2);
    // Under single-write commit the writer never advances the stored
    // hint (compactor-owned), so it lags the true tail the probe finds.
    expect(envelope.result.tail_hint).toBe(0);
    expect(envelope.result.discovered_tail).toBe(2);
    expect(envelope.result.log_seq_start).toBe(0);
    expect(envelope.result.live_log_tail).toBe(2);
    expect(envelope.result.snapshot).toBe(null);
    expect(envelope.result.snapshot_bytes).toBe(0);
    expect(envelope.result.snapshot_rows).toBe(0);
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.errors).toEqual([]);
  });

  test("text mode renders a human-readable summary", async () => {
    await provision(storage);
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "first" },
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("baerly inspect tickets");
    expect(text).toContain("materialised_rows:   1");
    expect(text).toContain("snapshot_bytes:      0");
    expect(text).toContain("snapshot_rows:       0");
    expect(text).toContain("status:              ok");
  });

  test("flags orphan snapshots in the errors array", async () => {
    await provision(storage);
    // Write a fake snapshot file at the canonical L9 path. current.json
    // still points at `null` (no snapshot), so this is an orphan.
    const orphanKey = `${TABLE_PREFIX}/snapshot/L9/000000000000-000000000000-ghosthash.json`;
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { status: string; errors: string[] };
    };
    expect(envelope.result.status).toBe("error");
    expect(envelope.result.errors.some((e) => e.includes(orphanKey))).toBe(true);
  });

  test("missing current.json surfaces InvalidConfig (exit 1)", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("traversal-shaped --collection rejected → InvalidConfig (exit 1)", async () => {
    // A read command must reject a traversal collection segment via the
    // same shared rule, before it builds a `../current.json`-shaped key.
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=..`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("baerly inspect");
    expect(msg).toContain("collection");
  });

  test("unknown flag rejected with exit 1", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--unknown=oops",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("unknown flag");
  });

  describe("fold_gate verdict", () => {
    interface GateVerdict {
      verdict: "open" | "closed:bytes" | "closed:rows";
      ceiling_bytes: number;
      ceiling_rows: number;
      retention_stalled: boolean;
    }
    type FoldGate = Partial<Record<"cf-free" | "cf-paid" | "node", GateVerdict>>;

    /** Provision with the stored snapshot figures the gate reads, plus `tail` live entries. */
    const provisionAt = async (
      figures: { snapshot_bytes: number; snapshot_rows: number },
      tail = 0,
    ): Promise<void> => {
      await createCurrentJson(storage, CURRENT_JSON_KEY, {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "inspect-test", claimed_at: "" },
        ...figures,
      });
      const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < tail; i++) {
        await writer.commit({
          op: "I",
          collection: COLL,
          docId: `t-${i}`,
          body: { _id: `t-${i}` },
        });
      }
    };

    const inspectGate = async (...extra: string[]): Promise<FoldGate> => {
      const stdout = captureStream(process.stdout);
      let exitCode: number;
      try {
        exitCode = await runInspect([
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--json",
          ...extra,
        ]);
      } finally {
        stdout.restore();
      }
      // A closed gate is a report, not a failure: the command's exit-0 contract holds.
      expect(exitCode).toBe(0);
      return (JSON.parse(stdout.captured.join("").trim()) as { result: { fold_gate: FoldGate } })
        .result.fold_gate;
    };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("an empty collection is open on every profile", async () => {
      await provisionAt({ snapshot_bytes: 0, snapshot_rows: 0 });
      const gate = await inspectGate();
      expect(gate).toEqual({
        "cf-free": {
          verdict: "open",
          ceiling_bytes: MAINTENANCE_PROFILE_CF_FREE.maxFoldBytes,
          ceiling_rows: MAINTENANCE_PROFILE_CF_FREE.maxFoldRows,
          retention_stalled: false,
        },
        "cf-paid": {
          verdict: "open",
          ceiling_bytes: MAINTENANCE_PROFILE_CF_PAID.maxFoldBytes,
          ceiling_rows: MAINTENANCE_PROFILE_CF_PAID.maxFoldRows,
          retention_stalled: false,
        },
        node: {
          verdict: "open",
          ceiling_bytes: MAINTENANCE_PROFILE_NODE.maxFoldBytes,
          ceiling_rows: MAINTENANCE_PROFILE_NODE.maxFoldRows,
          retention_stalled: false,
        },
      });
    });

    test("the rows arm closes at E - maxFoldEntriesPerPass + 1 stored rows, per profile", async () => {
      const free = MAINTENANCE_PROFILE_CF_FREE;
      await provisionAt({
        snapshot_bytes: 0,
        snapshot_rows: free.maxFoldRows - free.maxFoldEntriesPerPass + 1,
      });
      const gate = await inspectGate();
      expect(gate["cf-free"]?.verdict).toBe("closed:rows");
      expect(gate["cf-paid"]?.verdict).toBe("open");
      expect(gate.node?.verdict).toBe("open");
    });

    // The runner's projection is `snapshot_bytes <= C` and
    // `snapshot_rows + maxFoldEntriesPerPass <= E`, so a snapshot sitting
    // exactly on either ceiling still folds.
    test("exactly C stored bytes is still open", async () => {
      const free = MAINTENANCE_PROFILE_CF_FREE;
      await provisionAt({ snapshot_bytes: free.maxFoldBytes, snapshot_rows: 0 });
      const gate = await inspectGate("--profile=cf-free");
      expect(gate["cf-free"]?.verdict).toBe("open");
    });

    test("exactly E - maxFoldEntriesPerPass stored rows is still open", async () => {
      const free = MAINTENANCE_PROFILE_CF_FREE;
      await provisionAt({
        snapshot_bytes: 0,
        snapshot_rows: free.maxFoldRows - free.maxFoldEntriesPerPass,
      });
      const gate = await inspectGate("--profile=cf-free");
      expect(gate["cf-free"]?.verdict).toBe("open");
    });

    test("the bytes arm closes past C; --profile narrows the report to one host", async () => {
      await provisionAt({
        snapshot_bytes: MAINTENANCE_PROFILE_CF_PAID.maxFoldBytes + 1,
        snapshot_rows: 0,
      });
      await expect(inspectGate("--profile=cf-paid")).resolves.toEqual({
        "cf-paid": {
          verdict: "closed:bytes",
          ceiling_bytes: MAINTENANCE_PROFILE_CF_PAID.maxFoldBytes,
          ceiling_rows: MAINTENANCE_PROFILE_CF_PAID.maxFoldRows,
          retention_stalled: false,
        },
      });
      const nodeOnly = await inspectGate("--profile=node");
      expect(nodeOnly.node?.verdict).toBe("open");
    });

    test("BAERLY_MAINTENANCE_MAX_FOLD_BYTES in the CLI's environment overrides C", async () => {
      await provisionAt({ snapshot_bytes: 4096, snapshot_rows: 0 });
      vi.stubEnv("BAERLY_MAINTENANCE_MAX_FOLD_BYTES", "4095");
      const gate = await inspectGate();
      for (const profile of ["cf-free", "cf-paid", "node"] as const) {
        expect(gate[profile]?.verdict).toBe("closed:bytes");
        expect(gate[profile]?.ceiling_bytes).toBe(4095);
      }
    });

    /** Run `inspect --json` and return exit code, parsed result, and stderr. */
    const inspectJson = async (): Promise<{
      exitCode: number;
      result: { fold_gate: FoldGate; maintenance: string };
      stderr: string;
    }> => {
      const stdout = captureStream(process.stdout);
      const stderr = captureStream(process.stderr);
      let exitCode: number;
      try {
        exitCode = await runInspect([
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--json",
        ]);
      } finally {
        stdout.restore();
        stderr.restore();
      }
      const out = stdout.captured.join("").trim();
      return {
        exitCode,
        result: out === "" ? ({} as never) : JSON.parse(out).result,
        stderr: stderr.captured.join(""),
      };
    };

    // `inspect` is a read-only report: a maintenance env var the adapters
    // would reject is something to tell the operator, not a reason to fail.
    test.each([
      { name: "BAERLY_MAINTENANCE_DISABLE", value: "off" },
      { name: "BAERLY_MAINTENANCE_MAX_FOLD_BYTES", value: "0" },
    ])("an invalid $name=$value warns on stderr and still reports (exit 0)", async (env) => {
      await provisionAt({ snapshot_bytes: 0, snapshot_rows: 0 });
      vi.stubEnv(env.name, env.value);
      const { exitCode, result, stderr } = await inspectJson();
      expect(exitCode).toBe(0);
      // Falls back to the profile default `C`.
      expect(result.fold_gate["cf-free"]).toMatchObject({
        verdict: "open",
        ceiling_bytes: MAINTENANCE_PROFILE_CF_FREE.maxFoldBytes,
      });
      expect(stderr).toContain(env.name);
    });

    test("an invalid BAERLY_MAINTENANCE_DISABLE reports maintenance as invalid-config", async () => {
      await provisionAt({ snapshot_bytes: 0, snapshot_rows: 0 });
      vi.stubEnv("BAERLY_MAINTENANCE_DISABLE", "off");
      const { result } = await inspectJson();
      expect(result.maintenance).toBe("invalid-config");
    });

    test("an invalid MAX_FOLD_BYTES does not mask a valid DISABLE", async () => {
      await provisionAt({ snapshot_bytes: 0, snapshot_rows: 0 });
      vi.stubEnv("BAERLY_MAINTENANCE_MAX_FOLD_BYTES", "-5");
      vi.stubEnv("BAERLY_MAINTENANCE_DISABLE", "1");
      const { exitCode, result } = await inspectJson();
      expect(exitCode).toBe(0);
      expect(result.maintenance).toBe("disabled");
    });

    test("BAERLY_MAINTENANCE_DISABLE=1 reports maintenance as disabled in JSON and text", async () => {
      await provisionAt({ snapshot_bytes: 0, snapshot_rows: 0 });
      const enabled = await inspectJson();
      expect(enabled.result.maintenance).toBe("enabled");
      expect(enabled.stderr).toBe("");

      vi.stubEnv("BAERLY_MAINTENANCE_DISABLE", "1");
      const disabled = await inspectJson();
      expect(disabled.result.maintenance).toBe("disabled");

      const stdout = captureStream(process.stdout);
      try {
        await runInspect([
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
        ]);
      } finally {
        stdout.restore();
      }
      expect(stdout.captured.join("")).toMatch(/maintenance: +disabled/);
    });

    test("retention_stalled: a closed gate with a foldable-length live tail", async () => {
      await provisionAt(
        { snapshot_bytes: MAINTENANCE_PROFILE_CF_FREE.maxFoldBytes + 1, snapshot_rows: 0 },
        WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
      );
      const gate = await inspectGate();
      expect(gate["cf-free"]).toMatchObject({ verdict: "closed:bytes", retention_stalled: true });
      // Open gates never report a stall, however long the tail.
      expect(gate["cf-paid"]).toMatchObject({ verdict: "open", retention_stalled: false });
    });

    test("text mode prints one verdict line per profile", async () => {
      await provisionAt({
        snapshot_bytes: 0,
        snapshot_rows: MAINTENANCE_PROFILE_CF_FREE.maxFoldRows,
      });
      const stdout = captureStream(process.stdout);
      try {
        await runInspect([
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
        ]);
      } finally {
        stdout.restore();
      }
      const text = stdout.captured.join("");
      expect(text).toMatch(/fold_gate \(cf-free\): +closed:rows/);
      expect(text).toMatch(/fold_gate \(node\): +open/);
    });

    test("an unknown --profile is rejected (exit 1)", async () => {
      await provisionAt({ snapshot_bytes: 0, snapshot_rows: 0 });
      const stderr = captureStream(process.stderr);
      let exitCode: number;
      try {
        exitCode = await runInspect([
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--profile=lambda",
        ]);
      } finally {
        stderr.restore();
      }
      expect(exitCode).toBe(1);
    });
  });
});
