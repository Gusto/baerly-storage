import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { ProcessRunner } from "../deploy/cloudflare.ts";
import { doctorCloudflare, type DoctorFinding } from "./cloudflare.ts";

const PROD_WRANGLER = `{
  "name": "x",
  "main": "src/worker.ts",
  "compatibility_date": "2026-05-01",
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
    if (o !== undefined) {
      return o;
    }
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
    run: vi.fn<ProcessRunner["run"]>(async (cmd, args, _cwd) => {
      void _cwd;
      calls.push([cmd, ...args]);
      const r = lookup(args);
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }),
  };
  return { runner, calls };
};

const writeScaffold = async (repoRoot: string, content: string = PROD_WRANGLER): Promise<void> => {
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, "wrangler.jsonc"), content);
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

  test("reports ok when every check passes", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("ok");
    expect(findingFor(report.findings, "wrangler.jsonc")?.severity).toBe("ok");
    expect(findingFor(report.findings, "r2.x")?.severity).toBe("ok");
    expect(findingFor(report.findings, "secret.SHARED_SECRET")?.severity).toBe("ok");
    expect(findingFor(report.findings, "triggers.crons")?.severity).toBe("ok");
  });

  test("reports an error when wrangler.jsonc is missing", async () => {
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("error");
    expect(findingFor(report.findings, "wrangler.jsonc")?.severity).toBe("error");
  });

  test("reports an error when a declared R2 bucket is missing", async () => {
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

  test("creates the missing R2 bucket when --fix is set", async () => {
    await writeScaffold(repoRoot);
    const infoCalls = 0;
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

  test("warns when a required secret is missing", async () => {
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

  test("reports an error when cloudflareAccess.audienceTag is malformed", async () => {
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

  test("accepts a well-formed 64-char hex audienceTag", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const cfg = makeConfig(repoRoot, {
      cloudflareAccess: { teamDomain: "acme", audienceTag: "a".repeat(64) },
    });
    const report = await doctorCloudflare(cfg, { runner });
    expect(findingFor(report.findings, "cloudflareAccess")?.severity).toBe("ok");
  });

  test("warns when no cron triggers are declared", async () => {
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

  test("warns when baerly.config.ts:domain has no matching wrangler.jsonc:routes pattern", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const cfg = makeConfig(repoRoot, { domain: "app.example.com" });
    const report = await doctorCloudflare(cfg, { runner });
    const f = findingFor(report.findings, "routes.domain");
    expect(f?.severity).toBe("warning");
    expect(f?.fix).toContain("app.example.com/*");
  });

  test("accepts a matching domain ↔ routes pair", async () => {
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

  describe("--usage", () => {
    const R2_ENV_KEYS = ["CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const k of R2_ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of R2_ENV_KEYS) {
        if (savedEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedEnv[k];
        }
      }
    });

    test("emits error finding when R2 env vars are missing", async () => {
      await writeScaffold(repoRoot);
      const { runner } = makeRunner();
      const report = await doctorCloudflare(makeConfig(repoRoot), { runner, usage: true });
      const f = findingFor(report.findings, "usage-env-vars");
      expect(f?.severity).toBe("error");
      expect(f?.message).toContain("CF_ACCOUNT_ID");
      expect(f?.message).toContain("R2_ACCESS_KEY_ID");
      expect(f?.message).toContain("R2_SECRET_ACCESS_KEY");
      expect(f?.fix).toContain("R2 API Token");
    });

    test("partial env vars still surface the missing-vars finding listing only the gaps", async () => {
      process.env["CF_ACCOUNT_ID"] = "acct123";
      await writeScaffold(repoRoot);
      const { runner } = makeRunner();
      const report = await doctorCloudflare(makeConfig(repoRoot), { runner, usage: true });
      const f = findingFor(report.findings, "usage-env-vars");
      expect(f?.severity).toBe("error");
      expect(f?.message).not.toContain("CF_ACCOUNT_ID");
      expect(f?.message).toContain("R2_ACCESS_KEY_ID");
      expect(f?.message).toContain("R2_SECRET_ACCESS_KEY");
    });

    test("warns when no R2 bindings are declared in wrangler.jsonc", async () => {
      // wrangler.jsonc with zero r2_buckets — the parse succeeds with
      // an empty bindings list, so we fall through to the usage block
      // and emit a usage-no-binding warning.
      for (const k of R2_ENV_KEYS) {
        process.env[k] = `set-${k.toLowerCase()}`;
      }
      await writeScaffold(
        repoRoot,
        `{ "name": "x", "r2_buckets": [], "triggers": { "crons": ["* * * * *"] } }`,
      );
      const { runner } = makeRunner();
      const report = await doctorCloudflare(makeConfig(repoRoot), { runner, usage: true });
      // The bindings-empty warning is the new usage-specific signal;
      // earlier checks may also emit warnings for the empty list, so
      // assert against our specific check name.
      const f = findingFor(report.findings, "usage-no-binding");
      expect(f?.severity).toBe("warning");
    });

    test("does not emit usage findings when --usage is omitted", async () => {
      await writeScaffold(repoRoot);
      const { runner } = makeRunner();
      const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
      expect(findingFor(report.findings, "usage-env-vars")).toBeUndefined();
      expect(findingFor(report.findings, "usage-no-binding")).toBeUndefined();
    });
  });

  describe("extraFindings", () => {
    test("threads drift-check warnings through to the rollup", async () => {
      await writeScaffold(repoRoot);
      const { runner } = makeRunner();
      const report = await doctorCloudflare(makeConfig(repoRoot), {
        runner,
        extraFindings: [
          {
            severity: "warning",
            check: "index-filter-drift.users.admins",
            message: "users.admins: drift detected — 1 missing, 0 orphaned (3 in sync).",
            fix: "pnpm exec baerly admin rebuild-index --table=users --index=admins ...",
          },
        ],
      });
      expect(report.status).toBe("warning");
      const drift = findingFor(report.findings, "index-filter-drift.users.admins");
      expect(drift?.severity).toBe("warning");
      expect(drift?.fix).toContain("rebuild-index");
    });

    test("threads drift-check errors and bumps overall status to error", async () => {
      await writeScaffold(repoRoot);
      const { runner } = makeRunner();
      const report = await doctorCloudflare(makeConfig(repoRoot), {
        runner,
        extraFindings: [
          {
            severity: "error",
            check: "index-filter-drift.env",
            message: "missing env vars",
          },
        ],
      });
      expect(report.status).toBe("error");
    });
  });
});
