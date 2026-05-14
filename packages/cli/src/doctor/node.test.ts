import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.ts";
import { deployNode } from "../deploy/node.ts";
import { doctorNode } from "./node.ts";

const makeConfig = (repoRoot: string, extra: Partial<AppConfig> = {}): AppConfig => ({
  app: "svc",
  tenant: "t",
  target: "node",
  repoRoot,
  ...extra,
});

describe("doctorNode", () => {
  let outRoot: string;

  beforeEach(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "baerly-doctor-node-"));
    await mkdir(join(outRoot, "apps", "server"), { recursive: true });
  });

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("reports ok on a freshly-deployed app", async () => {
    await deployNode(makeConfig(outRoot));
    const r = await doctorNode(makeConfig(outRoot));
    expect(r.status).toBe("ok");
    expect(r.findings.find((f) => f.check === "Dockerfile present")?.severity).toBe("ok");
    expect(r.findings.find((f) => f.check === "Dockerfile matches emitted shape")?.severity).toBe(
      "ok",
    );
    expect(r.findings.find((f) => f.check === ".dockerignore present")?.severity).toBe("ok");
    expect(r.findings.find((f) => f.check === "systemd unit well-formed")?.severity).toBe("ok");
  });

  it("reports error when Dockerfile is missing", async () => {
    const r = await doctorNode(makeConfig(outRoot));
    expect(r.status).toBe("error");
    expect(r.findings.find((f) => f.check === "Dockerfile present")?.severity).toBe("error");
  });

  it("reports warning when .env.example doesn't mention a required secret", async () => {
    await deployNode(makeConfig(outRoot));
    await writeFile(join(outRoot, "apps/server/.env.example"), "# empty\n");
    const r = await doctorNode(makeConfig(outRoot, { requiredSecrets: ["MY_NEW_SECRET"] }));
    expect(
      r.findings.some(
        (f) => f.check === "secret MY_NEW_SECRET documented" && f.severity === "warning",
      ),
    ).toBe(true);
  });

  it("warns on a hand-edited Dockerfile (no distroless)", async () => {
    await deployNode(makeConfig(outRoot));
    await writeFile(join(outRoot, "apps/server/Dockerfile"), "FROM ubuntu:24.04\n");
    const r = await doctorNode(makeConfig(outRoot));
    expect(r.findings.find((f) => f.check === "Dockerfile matches emitted shape")?.severity).toBe(
      "warning",
    );
  });

  it("checks JWKS reachability when configured", async () => {
    await deployNode(makeConfig(outRoot));
    await writeFile(
      join(outRoot, "apps/server/.env.example"),
      "JWKS_URL=https://invalid.example.invalid/jwks\n",
    );
    const r = await doctorNode(makeConfig(outRoot));
    const jwksFinding = r.findings.find((f) => f.check === "JWKS URL reachable");
    expect(jwksFinding).toBeDefined();
    expect(jwksFinding?.severity).toBe("warning");
  }, 10_000);

  describe("extraFindings", () => {
    it("threads drift warnings through to the rollup", async () => {
      await deployNode(makeConfig(outRoot));
      const r = await doctorNode(makeConfig(outRoot), {
        extraFindings: [
          {
            severity: "warning",
            check: "index-filter-drift.tickets.open_only",
            message: "tickets.open_only: drift detected — 0 missing, 4 orphaned (12 in sync).",
            fix: "baerly admin rebuild-index ...",
          },
        ],
      });
      expect(r.status).toBe("warning");
      const drift = r.findings.find((f) => f.check === "index-filter-drift.tickets.open_only");
      expect(drift?.severity).toBe("warning");
    });

    it("threads drift errors and bumps the overall status", async () => {
      await deployNode(makeConfig(outRoot));
      const r = await doctorNode(makeConfig(outRoot), {
        extraFindings: [
          {
            severity: "error",
            check: "index-filter-drift.env",
            message: "missing storage env vars",
          },
        ],
      });
      expect(r.status).toBe("error");
    });
  });
});
