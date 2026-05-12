import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import type { AppConfig } from "../config";
import { deployNode } from "./node";

const makeConfig = (repoRoot: string): AppConfig => ({
  app: "svc",
  tenant: "t",
  target: "node",
  repoRoot,
});

describe("deployNode", () => {
  let outRoot: string;

  beforeEach(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "baerly-deploy-node-"));
    await mkdir(join(outRoot, "apps", "server"), { recursive: true });
  });

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("emits Dockerfile + pm2.config.cjs + systemd unit", async () => {
    const code = await deployNode(makeConfig(outRoot));
    expect(code).toBe(0);

    const dockerfile = await readFile(join(outRoot, "apps/server/Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM gcr.io/distroless/nodejs24-debian12");
    expect(dockerfile).toContain('org.opencontainers.image.title="svc"');

    const pm2 = await readFile(join(outRoot, "apps/server/pm2.config.cjs"), "utf8");
    expect(pm2).toContain('name: "svc"');

    const unit = await readFile(join(outRoot, "apps/server/systemd/baerly.service"), "utf8");
    expect(unit).toContain("Description=Baerly app — svc");

    const dockerignore = await readFile(join(outRoot, "apps/server/.dockerignore"), "utf8");
    expect(dockerignore).toContain("node_modules");

    const healthcheck = await readFile(join(outRoot, "apps/server/healthcheck.js"), "utf8");
    expect(healthcheck).toContain('path: "/v1/healthz"');

    const envExample = await readFile(join(outRoot, "apps/server/.env.example"), "utf8");
    expect(envExample).toContain("TENANT=t");
  });

  it("is idempotent — identical files leave exit 0", async () => {
    const first = await deployNode(makeConfig(outRoot));
    expect(first).toBe(0);
    const second = await deployNode(makeConfig(outRoot));
    expect(second).toBe(0);
  });

  it("returns exit 1 when a file has been hand-edited", async () => {
    await deployNode(makeConfig(outRoot));
    await writeFile(join(outRoot, "apps/server/Dockerfile"), "edited!\n");
    const code = await deployNode(makeConfig(outRoot));
    expect(code).toBe(1);
    // The hand-edited file should be left in place.
    const dockerfile = await readFile(join(outRoot, "apps/server/Dockerfile"), "utf8");
    expect(dockerfile).toBe("edited!\n");
  });

  it("overwrites hand-edits with --force", async () => {
    await deployNode(makeConfig(outRoot));
    await writeFile(join(outRoot, "apps/server/Dockerfile"), "edited!\n");
    const code = await deployNode(makeConfig(outRoot), { force: true });
    expect(code).toBe(0);
    const dockerfile = await readFile(join(outRoot, "apps/server/Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM gcr.io/distroless/nodejs24-debian12");
  });

  it("throws InvalidConfig when apps/server is missing", async () => {
    await rm(join(outRoot, "apps"), { recursive: true, force: true });
    try {
      await deployNode(makeConfig(outRoot));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });
});
