/**
 * Tests for the shared subcommand scaffolding. Exercise the five
 * pieces of boilerplate it owns:
 *   1. JSON-mode toggle (envelope on stderr in error path).
 *   2. Unknown-flag rejection.
 *   3. resolveAppTenant: explicit flags, config-only, partial flags.
 *   4. resolveAppTenant fail-loud when no flags AND no config.
 *   5. BaerlyError → exit code mapping (Conflict → 3).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { defineBaerlySubcommand } from "./subcommand.ts";

const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
};

describe("defineBaerlySubcommand", () => {
  let originalCwd: string;
  let root: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), "baerly-subcommand-"));
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test("unknown flag → InvalidConfig + JSON envelope + exit 1", async () => {
    const { run } = defineBaerlySubcommand({
      name: "probe",
      meta: { description: "test" },
      args: {
        bucket: { type: "string", required: true },
        json: { type: "boolean" },
      },
      handler: async () => 0,
    });
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await run(["--bucket=memory://b", "--unknown=oops", "--json"]);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(1);
    const text = stderr.captured.join("");
    const envelope = JSON.parse(text.trim()) as {
      error: { code: string; command: string; message: string };
    };
    expect(envelope.error.code).toBe("InvalidConfig");
    expect(envelope.error.command).toBe("probe");
    expect(envelope.error.message).toContain("--unknown");
  });

  test("resolveAppTenant fails loudly when no flags AND no config", async () => {
    const { run } = defineBaerlySubcommand({
      name: "probe",
      meta: { description: "test" },
      args: {
        app: { type: "string", required: false },
        tenant: { type: "string", required: false },
        json: { type: "boolean" },
      },
      handler: async (args, ctx) => {
        await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
        return 0;
      },
    });
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await run(["--json"]);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(1);
    const envelope = JSON.parse(stderr.captured.join("").trim()) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("InvalidConfig");
    expect(envelope.error.message).toContain("--app");
    expect(envelope.error.message).toContain("--tenant");
  });

  test("resolveAppTenant returns explicit flags when both supplied", async () => {
    let resolved: { app: string; tenant: string } | undefined;
    const { run } = defineBaerlySubcommand({
      name: "probe",
      meta: { description: "test" },
      args: {
        app: { type: "string", required: false },
        tenant: { type: "string", required: false },
      },
      handler: async (args, ctx) => {
        resolved = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
        return 0;
      },
    });
    const code = await run(["--app=appA", "--tenant=tenantB"]);
    expect(code).toBe(0);
    expect(resolved).toEqual({ app: "appA", tenant: "tenantB" });
  });

  test("resolveAppTenant fills missing flag from baerly.config.json", async () => {
    await writeFile(
      join(root, "baerly.config.json"),
      JSON.stringify({ app: "cfg-app", tenant: "cfg-tenant", target: "node" }),
      "utf8",
    );
    let resolved: { app: string; tenant: string } | undefined;
    const { run } = defineBaerlySubcommand({
      name: "probe",
      meta: { description: "test" },
      args: {
        app: { type: "string", required: false },
        tenant: { type: "string", required: false },
      },
      handler: async (args, ctx) => {
        resolved = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
        return 0;
      },
    });
    // Pass --app explicitly; --tenant should come from the config.
    const code = await run(["--app=override-app"]);
    expect(code).toBe(0);
    expect(resolved).toEqual({ app: "override-app", tenant: "cfg-tenant" });
  });

  test("BaerlyError(\"Conflict\") in handler → exit 3", async () => {
    const { run } = defineBaerlySubcommand({
      name: "probe",
      meta: { description: "test" },
      args: { json: { type: "boolean" } },
      handler: async () => {
        throw new BaerlyError("Conflict", "synthetic");
      },
    });
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await run(["--json"]);
    } finally {
      stderr.restore();
    }
    expect(code).toBe(3);
    const envelope = JSON.parse(stderr.captured.join("").trim()) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("Conflict");
    expect(envelope.error.message).toBe("synthetic");
  });
});
