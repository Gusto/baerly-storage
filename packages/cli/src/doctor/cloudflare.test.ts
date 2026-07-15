import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { ProcessRunner } from "../deploy/cloudflare.ts";
import {
  doctorCloudflare,
  type DoctorFinding,
  type DoctorReport,
  mergeReports,
} from "./cloudflare.ts";
import { captureStream } from "../_internal/testing.ts";

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
  auth: "shared-secret",
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
    await writeScaffold(
      repoRoot,
      `{
        "name": "x",
        "main": "src/worker.ts",
        "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "x" }],
        "vars": {
          "APP": "x",
          "TENANT": "default",
          "CF_ACCESS_TEAM_DOMAIN": "acme.cloudflareaccess.com",
          "CF_ACCESS_AUDIENCE_TAG": "${"a".repeat(64)}"
        },
        "triggers": { "crons": ["* * * * *"] }
      }`,
    );
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(report.status).toBe("ok");
    expect(findingFor(report.findings, "wrangler.jsonc")?.severity).toBe("ok");
    expect(findingFor(report.findings, "r2.x")?.severity).toBe("ok");
    expect(findingFor(report.findings, "secret.SHARED_SECRET")?.severity).toBe("ok");
    expect(findingFor(report.findings, "triggers.crons")?.severity).toBe("info");
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
    const stderr = captureStream(process.stderr);
    try {
      await doctorCloudflare(makeConfig(repoRoot), { runner, fix: true });
    } finally {
      stderr.restore();
    }
    expect(calls).toContainEqual(["wrangler", "r2", "bucket", "info", "x"]);
    expect(calls).toContainEqual(["wrangler", "r2", "bucket", "create", "x"]);
  });

  test("warns when a required secret is missing", async () => {
    // The default requiredSecrets walk still emits a warning when
    // SHARED_SECRET is unset. We pin `auth: "none"` here so the new
    // `auth.shared-secret-missing` FAIL doesn't blanket-bump the
    // rollup to "error" — that case is covered separately below.
    await writeScaffold(repoRoot);
    const { runner } = makeRunner({
      "secret list": { code: 0, stdout: "[]" },
    });
    const report = await doctorCloudflare(makeConfig(repoRoot, { auth: "none" }), { runner });
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

  test("accepts missing cron triggers because write-triggered maintenance is default", async () => {
    await writeScaffold(
      repoRoot,
      `{ "name": "x", "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "x" }] }`,
    );
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    const f = findingFor(report.findings, "triggers.crons");
    expect(f?.severity).toBe("ok");
    expect(f?.message).toContain("in-band write-triggered maintenance");
    expect(report.status).toBe("ok");
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

  test("the superseded shared-secret-without-access finding is gone", async () => {
    // Sanity gate: the old `shared-secret-without-access` check was
    // strictly narrower than the new auth-posture matrix and would
    // double-fire under the new policy. Verify it doesn't reappear.
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot), { runner });
    expect(findingFor(report.findings, "shared-secret-without-access")).toBeUndefined();
  });
});

describe("doctorCloudflare — config.auth", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "baerly-doctor-cf-auth-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test('auth: "none" + target: cloudflare → WARN auth.none-on-deploy', async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot, { auth: "none" }), { runner });
    const f = findingFor(report.findings, "auth.none-on-deploy");
    expect(f?.severity).toBe("warning");
    expect(f?.message).toContain('auth: "none"');
    expect(f?.message).toContain('"cloudflare"');
    expect(report.status).toBe("warning");
  });

  test('auth: "shared-secret" + SHARED_SECRET in wrangler secret list → no auth.shared-secret-missing', async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot, { auth: "shared-secret" }), {
      runner,
    });
    expect(findingFor(report.findings, "auth.shared-secret-missing")).toBeUndefined();
  });

  test('auth: "shared-secret" + SHARED_SECRET absent → FAIL auth.shared-secret-missing with locked wording', async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner({
      "secret list": { code: 0, stdout: "[]" },
    });
    const report = await doctorCloudflare(makeConfig(repoRoot, { auth: "shared-secret" }), {
      runner,
    });
    const f = findingFor(report.findings, "auth.shared-secret-missing");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain('auth="shared-secret"');
    expect(f?.message).toContain("SHARED_SECRET");
    expect(report.status).toBe("error");
  });

  test("CF Access vars present + config.auth=shared-secret → INFO auth.cf-access-inert", async () => {
    await writeScaffold(
      repoRoot,
      `{
        "name": "x",
        "main": "src/worker.ts",
        "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "x" }],
        "vars": {
          "APP": "x",
          "TENANT": "default",
          "CF_ACCESS_TEAM_DOMAIN": "acme.cloudflareaccess.com",
          "CF_ACCESS_AUDIENCE_TAG": "${"a".repeat(64)}"
        },
        "triggers": { "crons": ["* * * * *"] }
      }`,
    );
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot, { auth: "shared-secret" }), {
      runner,
    });
    const f = findingFor(report.findings, "auth.cf-access-inert");
    expect(f?.severity).toBe("info");
    expect(f?.message).toContain("CF_ACCESS_TEAM_DOMAIN");
  });

  test("CF Access vars absent → no auth.cf-access-inert", async () => {
    await writeScaffold(repoRoot);
    const { runner } = makeRunner();
    const report = await doctorCloudflare(makeConfig(repoRoot, { auth: "shared-secret" }), {
      runner,
    });
    expect(findingFor(report.findings, "auth.cf-access-inert")).toBeUndefined();
  });
});

// mergeReports is the glue `doctor.ts`'s gcs:// branch uses to fold the
// backend-agnostic CAS report together with the GCS bucket-config report.
describe("mergeReports", () => {
  const report = (...findings: DoctorFinding[]): DoctorReport => ({
    findings,
    status: "ok",
  });
  const ok: DoctorFinding = { severity: "ok", check: "cas", message: "" };
  const warn: DoctorFinding = { severity: "warning", check: "gcs-object-versioning", message: "" };
  const err: DoctorFinding = { severity: "error", check: "cas", message: "" };

  test("concatenates findings from all reports in order", () => {
    const merged = mergeReports([report(ok), report(warn)]);
    expect(merged.findings).toEqual([ok, warn]);
  });

  test("ok CAS + warning GCS config → overall warning (deployable)", () => {
    // Mirrors gcs:// with versioning enabled: CAS passes, config warns.
    expect(mergeReports([report(ok), report(warn)]).status).toBe("warning");
  });

  test("error CAS + ok GCS config → overall error (exit 2)", () => {
    // Mirrors gcs:// where the CAS probe itself fails.
    expect(mergeReports([report(err), report(ok)]).status).toBe("error");
  });

  test("empty input → ok with no findings", () => {
    expect(mergeReports([])).toEqual({ findings: [], status: "ok" });
  });
});
