import { execa } from "execa";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { diffGates, GATES, type GateRecord } from "../setup/gate-manifest.ts";

const skipped = (id: GateRecord["id"], file = "a.test.ts"): GateRecord => ({
  id,
  ran: false,
  file,
});
const ran = (id: GateRecord["id"], file = "a.test.ts"): GateRecord => ({ id, ran: true, file });

describe("diffGates", () => {
  test("a bare run expects nothing, so honest skips pass", () => {
    expect(
      diffGates({}, [skipped("minio"), skipped("conformance-aws"), skipped("sqlite")]),
    ).toEqual([]);
  });

  test("an opted-in gate that skipped is a violation", () => {
    const violations = diffGates({ CONFORMANCE: "1" }, [
      ran("conformance-gcs"),
      ran("conformance-cloudflare"),
      skipped("conformance-aws", "tests/integration/conformance.test.ts"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"conformance-aws"');
    expect(violations[0]).toContain("tests/integration/conformance.test.ts");
  });

  test("an opted-in gate no collected file reported is fine (path-filtered run)", () => {
    expect(diffGates({ MINIO: "1" }, [])).toEqual([]);
  });

  test("a required gate must run and must have been collected", () => {
    expect(
      diffGates({ BAERLY_REQUIRED_GATES: "git, sqlite" }, [ran("git"), ran("sqlite")]),
    ).toEqual([]);
    expect(diffGates({ BAERLY_REQUIRED_GATES: "sqlite" }, [skipped("sqlite")])).toHaveLength(1);
    expect(diffGates({ BAERLY_REQUIRED_GATES: "sqlite" }, [])).toHaveLength(1);
  });

  test("one skip among several runs of the same gate is a violation", () => {
    expect(diffGates({ MINIO: "1" }, [ran("minio", "a"), skipped("minio", "b")])).toHaveLength(1);
  });

  test("an unknown required gate is a violation, not ignored", () => {
    const violations = diffGates({ BAERLY_REQUIRED_GATES: "mino" }, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"mino"');
  });

  test("every gate has a skip reason", () => {
    for (const spec of Object.values(GATES)) {
      expect(spec.reason.length).toBeGreaterThan(0);
    }
  });
});

// End to end through vitest itself: the fixture project wires the real
// global setup over a file whose gated suites always skip. Proves the
// teardown assertion turns the run's exit code red, which `diffGates`
// alone cannot.
describe("gate ledger in a real vitest run", () => {
  vi.setConfig({ testTimeout: 30_000 });
  const config = join(import.meta.dirname, "../fixtures/gate-manifest/vitest.config.ts");
  const vitestBin = join(import.meta.dirname, "../../node_modules/vitest/vitest.mjs");

  const runVitest = async (gateEnv: Record<string, string>, args = ["--config", config]) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) {
      // Drop the parent worker's vitest state and any ambient gate env so
      // only `gateEnv` decides what the nested run expects.
      if (
        key.startsWith("VITEST") ||
        key === "BAERLY_REQUIRED_GATES" ||
        key === "CONFORMANCE" ||
        key === "MINIO" ||
        key === "NODE_DEPLOY_URL" ||
        key === "CF_DEPLOY_URL" ||
        key === "SHARED_SECRET"
      ) {
        delete env[key];
      }
    }
    return execa("node", [vitestBin, "run", ...args], {
      env: { ...env, ...gateEnv },
      extendEnv: false,
      reject: false,
      all: true,
    });
  };

  test("skips nobody expected leave the run green; an expected skip turns it red", async () => {
    const [bare, required, optedIn] = await Promise.all([
      runVitest({}),
      runVitest({ BAERLY_REQUIRED_GATES: "sqlite" }),
      runVitest({ CONFORMANCE: "1" }),
    ]);

    // The output rides along so a failure shows the nested run's log.
    expect({ exitCode: bare.exitCode, output: bare.all }).toMatchObject({ exitCode: 0 });

    expect({ exitCode: required.exitCode, output: required.all }).toMatchObject({ exitCode: 1 });
    expect(required.all).toContain('gate "sqlite" was expected to run but skipped');
    expect(required.all).toContain("skipped-suites.fixture.ts");

    expect({ exitCode: optedIn.exitCode, output: optedIn.all }).toMatchObject({ exitCode: 1 });
    expect(optedIn.all).toContain('gate "conformance-aws" was expected to run but skipped');
  });

  const deploys: {
    target: string;
    gate: GateRecord["id"];
    url: string;
    storage: Record<string, string>;
  }[] = [
    {
      target: "node",
      gate: "deploy-node-s3-cascade",
      url: "NODE_DEPLOY_URL",
      storage: {
        AWS_ACCESS_KEY_ID: "test-access",
        AWS_SECRET_ACCESS_KEY: "test-secret",
        BUCKET: "test-bucket",
      },
    },
    {
      target: "cloudflare",
      gate: "deploy-cloudflare-r2-cascade",
      url: "CF_DEPLOY_URL",
      storage: {
        CF_R2_S3_ENDPOINT: "https://storage.invalid",
        CF_R2_ACCESS_KEY_ID: "test-access",
        CF_R2_SECRET_ACCESS_KEY: "test-secret",
      },
    },
  ];

  for (const deploy of deploys) {
    test.each([deploy.url, "SHARED_SECRET"])(
      `required ${deploy.target} cascade fails when %s is missing`,
      async (missing) => {
        const env: Record<string, string> = {
          ...deploy.storage,
          [deploy.url]: "https://deploy.invalid",
          SHARED_SECRET: "test-secret",
          BAERLY_REQUIRED_GATES: deploy.gate,
        };
        delete env[missing];
        const result = await runVitest(env, [
          "--project=default",
          `manual-e2e/${deploy.target}/e2e.test.ts`,
        ]);
        expect({ exitCode: result.exitCode, output: result.all }).toMatchObject({ exitCode: 1 });
        expect(result.all).toContain(`gate "${deploy.gate}" was expected to run but skipped`);
      },
    );
  }
});
