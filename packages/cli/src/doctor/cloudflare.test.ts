import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import type { ProcessRunner } from "../deploy/cloudflare";
import { doctorCloudflare, type DoctorFinding } from "./cloudflare";

const PROD_WRANGLER = `{
  "name": "x",
  "main": "src/worker.ts",
  "compatibility_date": "2025-06-01",
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "x" }
  ],
  "vars": { "APP": "x", "TENANT": "default" },
  "triggers": { "crons": ["* * * * *"] },
}
`;

interface CannedReply {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const makeRunner = (overrides: { readonly [key: string]: CannedReply } = {}) => {
  const calls: string[][] = [];
  const lookup = (args: readonly string[]): CannedReply => {
    const key = args.join(" ");
    const o = overrides[key];
    if (o !== undefined) return o;
    if (args[0] === "r2" && args[1] === "bucket" && args[2] === "info") {
      return { code: 0, stdout: "ok" };
    }
    if (args[0] === "r2" && args[1] === "bucket" && args[2] === "create") {
      return { code: 0, stdout: "created" };
    }
    if (args[0] === "secret" && args[1] === "list") {
      return { code: 0, stdout: '[{"name":"SHARED_SECRET","type":"secret_text"}]' };
    }
    return { code: 0, stdout: "" };
  };
  const runner: ProcessRunner = {
    run: vi.fn(async (cmd, args, _cwd) => {
      void _cwd;
      calls.push([cmd, ...args]);
      const r = lookup(args);
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }),
  };
  return { runner, calls };
};

const writeScaffold = async (repoRoot: string, content: string = PROD_WRANGLER): Promise<void> => {
  await mkdir(join(repoRoot, "apps/server"), { recursive: true });
  await writeFile(join(repoRoot, "apps/server/wrangler.jsonc"), content);
};

const makeConfig = (repoRoot: string, extra: Partial<AppConfig> = {}): AppConfig => ({
  app: "x",
  tenant: "default",
  target: "cloudflare",
  repoRoot,
  ...extra,
});

const findingFor = (findings: readonly DoctorFinding[], check: string): DoctorFinding | undefined =>
  findings.find((f) => f.check === check);

describe("doctorCloudflare", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "baerly-doctor-cf-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("reports ok when every check passes", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("ok");
    expect(findingFor(report.findings, "wrangler.jsonc")?.severity).toBe("ok");
    expect(findingFor(report.findings, "r2.x")?.severity).toBe("ok");
    expect(findingFor(report.findings, "secret.SHARED_SECRET")?.severity).toBe("ok");
    expect(findingFor(report.findings, "triggers.crons")?.severity).toBe("ok");
  });

  it("reports an error when wrangler.jsonc is missing", async () => {
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("error");
    expect(findingFor(report.findings, "wrangler.jsonc")?.severity).toBe("error");
  });

  it("reports an error when a declared R2 bucket is missing", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner({
      "r2 bucket info x": { code: 1, stderr: "not found" },
    });
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("error");
    const f = findingFor(report.findings, "r2.x");
    expect(f?.severity).toBe("error");
    expect(f?.fix).toContain("wrangler r2 bucket create x");
  });

  it("creates the missing R2 bucket when --fix is set", async () => {
    await writeScaffold(repoRoot);
    let infoCalls = 0;
    const overrides: Record<string, CannedReply> = {
      "r2 bucket info x": { code: 1, stderr: "not found" },
    };
    const { runner, calls } = makeRunner(overrides);
    // After the fix, the next info call should also report missing
    // because we only mocked the failing path. The intent of this
    // test is just to assert `r2 bucket create x` was issued.
    void infoCalls;
    await doctorCloudflare(makeConfig(repoRoot), { runner, fix: true });
    expect(calls).toContainEqual(["wrangler", "r2", "bucket", "info", "x"]);
    expect(calls).toContainEqual(["wrangler", "r2", "bucket", "create", "x"]);
  });

  it("warns when a required secret is missing", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner({
      "secret list": { code: 0, stdout: "[]" },
    });
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("warning");
    const f = findingFor(report.findings, "secret.SHARED_SECRET");
    expect(f?.severity).toBe("warning");
    expect(f?.fix).toBe("wrangler secret put SHARED_SECRET");
  });

  it("reports an error when cloudflareAccess.audienceTag is malformed", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const cfg = makeConfig(repoRoot, {
      cloudflareAccess: { teamDomain: "acme", audienceTag: "not-hex" },
    });
    const report = await doctorCloudflare(cfg, { runner });
    expect(report.status).toBe("error");
    const f = findingFor(report.findings, "cloudflareAccess.audienceTag");
    expect(f?.severity).toBe("error");
  });

  it("accepts a well-formed 64-char hex audienceTag", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const cfg = makeConfig(repoRoot, {
      cloudflareAccess: { teamDomain: "acme", audienceTag: "a".repeat(64) },
    });
    const report = await doctorCloudflare(cfg, { runner });
    expect(findingFor(report.findings, "cloudflareAccess")?.severity).toBe("ok");
  });

  it("warns when no cron triggers are declared", async () => {
    await writeScaffold(
      repoRoot,
      `{ "name": "x", "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "x" }] }`,
    );
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    const f = findingFor(report.findings, "triggers.crons");
    expect(f?.severity).toBe("warning");
    expect(report.status).toBe("warning");
  });

  it("warns when baerly.config.ts:domain has no matching wrangler.jsonc:routes pattern", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const cfg = makeConfig(repoRoot, { domain: "app.example.com" });
    const report = await doctorCloudflare(cfg, { runner });
    const f = findingFor(report.findings, "routes.domain");
    expect(f?.severity).toBe("warning");
    expect(f?.fix).toContain("app.example.com/*");
  });

  it("accepts a matching domain ↔ routes pair", async () => {
    await writeScaffold(
      repoRoot,
      `{
        "name": "x",
        "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "x" }],
        "triggers": { "crons": ["* * * * *"] },
        "routes": [{ "pattern": "app.example.com/*", "custom_domain": true }]
      }`,
    );
    const { runner } = makeRunner();
    const cfg = makeConfig(repoRoot, { domain: "app.example.com" });
    const report = await doctorCloudflare(cfg, { runner });
    expect(findingFor(report.findings, "routes.domain")?.severity).toBe("ok");
  });
});
