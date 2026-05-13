import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffold } from "./scaffold.ts";

const TEMPLATES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");

describe("scaffold", () => {
  let outRoot: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "create-baerly-"));
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("emits a cloudflare scaffold with substituted placeholders", async () => {
    const result = await scaffold({
      projectName: "my-app",
      target: "cloudflare",
      pm: "pnpm",
      tenant: "acme",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain("package.json");
    expect(result.filesWritten).toContain(join("apps", "server", "wrangler.jsonc"));
    expect(result.filesWritten).toContain("AGENTS.md");
    expect(result.filesWritten).toContain("CLAUDE.md");
    const agentsMd = await readFile(join(result.outDir, "AGENTS.md"), "utf8");
    const claudeMd = await readFile(join(result.outDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toEqual(agentsMd);
    // Sanity-check: both have placeholders substituted (no `{{appName}}` left).
    expect(claudeMd).not.toContain("{{appName}}");
    expect(claudeMd).toContain("my-app");

    const pkg = JSON.parse(await readFile(join(result.outDir, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("my-app");

    const config = await readFile(join(result.outDir, "baerly.config.ts"), "utf8");
    expect(config).toContain('app: "my-app"');
    expect(config).toContain('tenant: "acme"');
    expect(config).toContain('target: "cloudflare"');

    const wrangler = await readFile(
      join(result.outDir, "apps", "server", "wrangler.jsonc"),
      "utf8",
    );
    expect(wrangler).toContain('"name": "my-app"');
    expect(wrangler).toContain('"bucket_name": "my-app"');
    expect(wrangler).toContain('"TENANT": "acme"');

    const worker = await readFile(
      join(result.outDir, "apps", "server", "src", "worker.ts"),
      "utf8",
    );
    expect(worker).toContain("sharedSecret");
    expect(worker).toContain('tenantPrefix: "acme"');
  });

  it("emits a production-shape wrangler.jsonc for cloudflare", async () => {
    const result = await scaffold({
      projectName: "prod-app",
      target: "cloudflare",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    const wrangler = await readFile(
      join(result.outDir, "apps", "server", "wrangler.jsonc"),
      "utf8",
    );
    expect(wrangler).toContain('"r2_buckets":');
    expect(wrangler).toContain('"triggers":');
    expect(wrangler).toContain('"limits":');
    expect(wrangler).toContain('"observability":');
    expect(wrangler).toContain('"name": "prod-app"');
  });

  it("emits a node scaffold with the bearerJwt fallback verifier", async () => {
    const result = await scaffold({
      projectName: "svc-a",
      target: "node",
      pm: "npm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(join("apps", "server", "src", "server.ts"));
    expect(result.filesWritten).toContain(join("apps", "server", "Dockerfile"));
    expect(result.filesWritten).not.toContain(join("apps", "server", "wrangler.jsonc"));
    expect(result.filesWritten).toContain("AGENTS.md");
    expect(result.filesWritten).toContain("CLAUDE.md");
    const agentsMd = await readFile(join(result.outDir, "AGENTS.md"), "utf8");
    const claudeMd = await readFile(join(result.outDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toEqual(agentsMd);

    const server = await readFile(
      join(result.outDir, "apps", "server", "src", "server.ts"),
      "utf8",
    );
    expect(server).toContain("bearerJwt");
    expect(server).toContain("sharedSecret");
    expect(server).toContain('const APP = "svc-a"');

    const config = await readFile(join(result.outDir, "baerly.config.ts"), "utf8");
    expect(config).toContain('target: "node"');
  });

  it("emits a production-shape Dockerfile + pm2 + systemd unit for node", async () => {
    const result = await scaffold({
      projectName: "prod-node",
      target: "node",
      pm: "pnpm",
      tenant: "acme",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(join("apps", "server", "Dockerfile"));
    expect(result.filesWritten).toContain(join("apps", "server", "healthcheck.js"));
    expect(result.filesWritten).toContain(join("apps", "server", ".dockerignore"));
    expect(result.filesWritten).toContain(join("apps", "server", "pm2.config.cjs"));
    expect(result.filesWritten).toContain(join("apps", "server", "systemd", "baerly.service"));
    expect(result.filesWritten).toContain(join("apps", "server", ".env.example"));

    const dockerfile = await readFile(join(result.outDir, "apps", "server", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM gcr.io/distroless/nodejs24-debian12");
    expect(dockerfile).toContain("USER nonroot:nonroot");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('org.opencontainers.image.title="prod-node"');

    const pm2Config = await readFile(
      join(result.outDir, "apps", "server", "pm2.config.cjs"),
      "utf8",
    );
    expect(pm2Config).toContain('name: "prod-node"');

    const unit = await readFile(
      join(result.outDir, "apps", "server", "systemd", "baerly.service"),
      "utf8",
    );
    expect(unit).toContain("Description=Baerly app — prod-node");
    expect(unit).toContain("EnvironmentFile=/etc/baerly/prod-node.env");

    const envExample = await readFile(
      join(result.outDir, "apps", "server", ".env.example"),
      "utf8",
    );
    expect(envExample).toContain("TENANT=acme");
  });

  it("rejects projectName with disallowed characters", async () => {
    await expect(
      scaffold({
        projectName: "Invalid Name!",
        target: "cloudflare",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/projectName must be lowercase/);
  });

  it("rejects an empty projectName", async () => {
    await expect(
      scaffold({
        projectName: "",
        target: "cloudflare",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/projectName must be non-empty/);
  });

  it("refuses to overwrite a non-empty directory", async () => {
    await scaffold({
      projectName: "exists",
      target: "node",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    await expect(
      scaffold({
        projectName: "exists",
        target: "node",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/exists and is non-empty/);
  });

  it("returns the correct nextSteps for each detected PM", async () => {
    const r = await scaffold({
      projectName: "pm-test",
      target: "cloudflare",
      pm: "yarn",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(r.nextSteps).toEqual(["cd pm-test", "yarn install", "yarn dev"]);
  });

  it("rejects an unknown target template", async () => {
    await expect(
      scaffold({
        projectName: "ghost-target",
        // The cast bypasses the type guard so we can prove the runtime
        // check fires. The CLI's parser catches this earlier in normal
        // use.
        target: "lambda" as "cloudflare",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/template not found for target=lambda/);
  });
});
