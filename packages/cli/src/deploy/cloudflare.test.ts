import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BaerlyError } from "@baerly/protocol";
import type { AppConfig } from "../config.ts";
import {
  type CasProbe,
  deployCloudflare,
  ensureBindings,
  parseR2Bindings,
  type ProcessRunner,
} from "./cloudflare.ts";

const WRANGLER_JSONC = `{
  // Production manifest comment.
  "name": "x",
  "main": "src/worker.ts",
  "compatibility_date": "2026-05-01",
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "x" }
  ],
  "vars": { "APP": "x", "TENANT": "default" },
}
`;

interface RunnerHandle {
  readonly runner: ProcessRunner;
  readonly calls: readonly (readonly string[])[];
  readonly stderr: () => string;
}

interface CannedReply {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Build a ProcessRunner that returns canned replies based on the
 * head of the args array. `defaults` lets callers override the
 * stock responses.
 */
const makeRunner = (defaults: { readonly [key: string]: CannedReply } = {}): RunnerHandle => {
  const calls: string[][] = [];
  let stderrBuf = "";
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;

  const lookup = (args: readonly string[]): CannedReply => {
    const key = args.join(" ");
    const override = defaults[key];
    if (override !== undefined) {
      return override;
    }
    if (args[0] === "deploy" && args[1] === "--help") {
      return { code: 0, stdout: "Usage: wrangler deploy [--x-provision] [--x-auto-create] ..." };
    }
    if (args[0] === "secret" && args[1] === "list") {
      return { code: 0, stdout: '[{"name":"SHARED_SECRET","type":"secret_text"}]' };
    }
    if (args[0] === "deploy") {
      return { code: 0, stdout: "Deployed." };
    }
    if (args[0] === "r2" && args[1] === "bucket" && args[2] === "info") {
      return { code: 0, stdout: "ok" };
    }
    if (args[0] === "r2" && args[1] === "bucket" && args[2] === "create") {
      return { code: 0, stdout: "created" };
    }
    return { code: 0, stdout: "" };
  };

  const runner: ProcessRunner = {
    run: vi.fn<ProcessRunner["run"]>(async (cmd, args, _cwd) => {
      void _cwd;
      calls.push([cmd, ...args]);
      const reply = lookup(args);
      return {
        code: reply.code,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
      };
    }),
  };

  return {
    runner,
    calls,
    stderr: () => {
      process.stderr.write = realWrite;
      return stderrBuf;
    },
  };
};

const writeScaffold = async (
  repoRoot: string,
  wranglerContent: string = WRANGLER_JSONC,
): Promise<void> => {
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, "wrangler.jsonc"), wranglerContent);
};

const makeConfig = (repoRoot: string): AppConfig => ({
  app: "x",
  tenant: "default",
  target: "cloudflare",
  auth: "shared-secret",
  repoRoot,
});

describe("parseR2Bindings", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "baerly-deploy-cf-parse-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("parses comments + trailing commas", async () => {
    await writeScaffold(repoRoot);
    const bindings = parseR2Bindings(join(repoRoot, "wrangler.jsonc"));
    expect(bindings).toEqual([{ binding: "BUCKET", bucket_name: "x" }]);
  });

  test("returns [] when r2_buckets is absent", async () => {
    await writeScaffold(repoRoot, '{ "name": "x" }\n');
    expect(parseR2Bindings(join(repoRoot, "wrangler.jsonc"))).toEqual([]);
  });

  test("throws InvalidConfig on missing file", () => {
    expect(() => parseR2Bindings(join(repoRoot, "does-not-exist.jsonc"))).toThrow(
      /missing\. Expected wrangler\.jsonc at the package root/,
    );
  });

  test("throws InvalidConfig on malformed JSONC", async () => {
    await writeScaffold(repoRoot, '{ "name": "x" "broken": true }');
    try {
      parseR2Bindings(join(repoRoot, "wrangler.jsonc"));
      throw new Error("expected throw");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws InvalidConfig when r2_buckets[] entry is missing bucket_name", async () => {
    await writeScaffold(repoRoot, '{ "name": "x", "r2_buckets": [{ "binding": "B" }] }');
    try {
      parseR2Bindings(join(repoRoot, "wrangler.jsonc"));
      throw new Error("expected throw");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  // Regression sentinel for the scaffold flatten — `parseR2Bindings`
  // must parse the source-of-truth `examples/minimal-cloudflare/wrangler.jsonc`
  // that the rolldown build ships into `dist/templates/`. If anyone
  // moves `wrangler.jsonc` back under `apps/server/` (or changes the
  // R2 binding name), this test fails before drift can land.
  test("parses the bundled examples/minimal-cloudflare/wrangler.jsonc cleanly", () => {
    // Walk up from `packages/cli/src/deploy/` to the worktree root,
    // then into `examples/minimal-cloudflare/wrangler.jsonc`.
    const wranglerPath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "examples",
      "minimal-cloudflare",
      "wrangler.jsonc",
    );
    const bindings = parseR2Bindings(wranglerPath);
    expect(bindings).toEqual([{ binding: "BUCKET", bucket_name: "minimal-cloudflare" }]);
  });
});

describe("deployCloudflare", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "baerly-deploy-cf-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("invokes wrangler deploy --x-provision --x-auto-create when supported", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner();
    const exit = await deployCloudflare(makeConfig(repoRoot), { runner: h.runner });
    h.stderr();
    expect(exit).toBe(0);
    expect(h.calls).toContainEqual(["wrangler", "deploy", "--x-provision", "--x-auto-create"]);
    expect(h.calls).not.toContainEqual(["wrangler", "deploy"]);
  });

  test("CAS preflight failure aborts before any wrangler invocation", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner();
    const casProbe = vi.fn<CasProbe>(async (_uri) => ({
      status: "error" as const,
      findings: [
        {
          severity: "error" as const,
          check: "cas-ifNoneMatch-concurrent",
          message: "two concurrent create-if-absent writes both won",
        },
      ],
    }));
    let thrown: BaerlyError | undefined;
    try {
      await deployCloudflare(makeConfig(repoRoot), {
        runner: h.runner,
        probeBucketUri: "s3://bad-bucket",
        casProbe,
      });
    } catch (error) {
      thrown = error as BaerlyError;
    }
    h.stderr();
    expect(thrown?.code).toBe("NetworkError");
    expect(thrown?.message).toContain("CAS preflight against s3://bad-bucket failed");
    expect(thrown?.message).toContain("cas-ifNoneMatch-concurrent");
    expect(casProbe).toHaveBeenCalledWith("s3://bad-bucket");
    // The abort happens before wrangler is touched at all.
    expect(h.calls).toEqual([]);
  });

  test("CAS preflight success proceeds to deploy", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner();
    const casProbe = vi.fn<CasProbe>(async (_uri) => ({ status: "ok" as const, findings: [] }));
    const exit = await deployCloudflare(makeConfig(repoRoot), {
      runner: h.runner,
      probeBucketUri: "s3://good-bucket",
      casProbe,
    });
    h.stderr();
    expect(exit).toBe(0);
    expect(casProbe).toHaveBeenCalledWith("s3://good-bucket");
    expect(h.calls).toContainEqual(["wrangler", "deploy", "--x-provision", "--x-auto-create"]);
  });

  test("no preflight runs when probeBucketUri is omitted", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner();
    const casProbe = vi.fn<CasProbe>(async (_uri) => ({ status: "ok" as const, findings: [] }));
    const exit = await deployCloudflare(makeConfig(repoRoot), { runner: h.runner, casProbe });
    h.stderr();
    expect(exit).toBe(0);
    expect(casProbe).not.toHaveBeenCalled();
  });

  test("falls back to manual provisioning when --x-provision is missing", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner({
      "deploy --help": { code: 0, stdout: "Usage: wrangler deploy [--env <env>] ..." },
      "r2 bucket info x": { code: 1, stderr: "not found" },
    });
    const exit = await deployCloudflare(makeConfig(repoRoot), { runner: h.runner });
    h.stderr();
    expect(exit).toBe(0);
    expect(h.calls).toContainEqual(["wrangler", "r2", "bucket", "info", "x"]);
    expect(h.calls).toContainEqual(["wrangler", "r2", "bucket", "create", "x"]);
    expect(h.calls).toContainEqual(["wrangler", "deploy"]);
    expect(h.calls).not.toContainEqual(["wrangler", "deploy", "--x-provision", "--x-auto-create"]);
  });

  test("warns when a required secret is missing", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner({
      "secret list": { code: 0, stdout: "[]" },
    });
    await deployCloudflare(makeConfig(repoRoot), { runner: h.runner });
    const stderr = h.stderr();
    expect(stderr).toContain("SHARED_SECRET is required but unset");
    expect(stderr).toContain("wrangler secret put SHARED_SECRET");
  });

  test("respects a custom requiredSecrets list", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner({
      "secret list": { code: 0, stdout: '[{"name":"AUDIENCE_TAG","type":"secret_text"}]' },
    });
    const config: AppConfig = { ...makeConfig(repoRoot), requiredSecrets: ["AUDIENCE_TAG"] };
    await deployCloudflare(config, { runner: h.runner });
    const stderr = h.stderr();
    expect(stderr).not.toContain("AUDIENCE_TAG is required but unset");
  });

  test("throws InvalidConfig when wrangler.jsonc is missing", async () => {
    // No scaffold written.
    const h = makeRunner();
    try {
      await deployCloudflare(makeConfig(repoRoot), { runner: h.runner });
      throw new Error("expected throw");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    } finally {
      h.stderr();
    }
  });

  test("throws NetworkError when bucket creation fails in the fallback", async () => {
    await writeScaffold(repoRoot);
    const h = makeRunner({
      "deploy --help": { code: 0, stdout: "Usage: wrangler deploy [--env <env>] ..." },
      "r2 bucket info x": { code: 1, stderr: "not found" },
      "r2 bucket create x": { code: 1, stderr: "permission denied" },
    });
    try {
      await deployCloudflare(makeConfig(repoRoot), { runner: h.runner });
      throw new Error("expected throw");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("NetworkError");
    } finally {
      h.stderr();
    }
  });
});

describe("ensureBindings", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "baerly-deploy-cf-bind-"));
    await writeScaffold(repoRoot);
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("creates a missing bucket but skips one that already exists", async () => {
    await writeScaffold(
      repoRoot,
      `{ "r2_buckets": [
        { "binding": "A", "bucket_name": "have-it" },
        { "binding": "B", "bucket_name": "need-it" }
      ] }`,
    );
    const h = makeRunner({
      "r2 bucket info have-it": { code: 0, stdout: "ok" },
      "r2 bucket info need-it": { code: 1, stderr: "not found" },
    });
    await ensureBindings(h.runner, repoRoot, join(repoRoot, "wrangler.jsonc"));
    h.stderr();
    expect(h.calls).toContainEqual(["wrangler", "r2", "bucket", "info", "have-it"]);
    expect(h.calls).toContainEqual(["wrangler", "r2", "bucket", "info", "need-it"]);
    expect(h.calls).toContainEqual(["wrangler", "r2", "bucket", "create", "need-it"]);
    expect(h.calls).not.toContainEqual(["wrangler", "r2", "bucket", "create", "have-it"]);
  });
});
