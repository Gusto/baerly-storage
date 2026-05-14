import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import { scaffold } from "./scaffold.ts";

// `examples/` (containing `minimal-cloudflare/` and `minimal-node/`)
// is the new templates root after the Step-3 migration. The
// scaffolder's `TARGET_TO_EXAMPLE` map resolves a target to the
// matching example directory under this root.
const TEMPLATES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "examples",
);
const EXAMPLE_DIRS = [
  resolve(TEMPLATES_ROOT, "minimal-cloudflare"),
  resolve(TEMPLATES_ROOT, "minimal-node"),
];

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

  // Drift sentinel: both example trees were migrated off the old
  // `\{\{...\}\}` placeholder convention to manifest-driven sentinel
  // renames. If anyone reintroduces a `\{\{placeholder\}\}` to one of
  // the examples — by hand or from a copy/paste — the scaffolder
  // will quietly emit it into a fresh app, where it would crash at
  // tsc / wrangler / pm2 startup. This test fails loudly on the
  // source side so that regression never ships.
  test("examples contain no {{placeholder}} substrings", async () => {
    const PLACEHOLDER_RE = /\{\{\w+\}\}/;
    const skipName = (name: string): boolean => name === "node_modules";
    const skipRel = (rel: string): boolean => rel === join(".baerly", "scaffold.json");
    const walk = async (root: string, rel: string, hits: string[]): Promise<void> => {
      const abs = rel === "" ? root : join(root, rel);
      const ents = await readdir(abs, { withFileTypes: true });
      for (const ent of ents) {
        if (skipName(ent.name)) continue;
        const relEnt = rel === "" ? ent.name : join(rel, ent.name);
        if (skipRel(relEnt)) continue;
        if (ent.isDirectory()) {
          await walk(root, relEnt, hits);
          continue;
        }
        if (!ent.isFile()) continue;
        const st = await stat(join(root, relEnt));
        // Treat anything > 1 MiB as binary — examples don't ship
        // large blobs but a guard keeps the walk fast under churn.
        if (st.size > 1024 * 1024) continue;
        let text: string;
        try {
          text = await readFile(join(root, relEnt), "utf8");
        } catch {
          continue;
        }
        if (PLACEHOLDER_RE.test(text)) {
          hits.push(`${relative(TEMPLATES_ROOT, root)}/${relEnt}`);
        }
      }
    };
    const hits: string[] = [];
    for (const dir of EXAMPLE_DIRS) await walk(dir, "", hits);
    expect(hits, `unexpected {{placeholder}} substrings in examples: ${hits.join(", ")}`).toEqual(
      [],
    );
  });

  // End-to-end scaffold + rename. Drives the scaffolder for each
  // target with concrete user inputs into a tmpdir and validates the
  // post-substitute invariants the CLI relies on: package.json
  // identity, baerly.config.ts content, @baerly/* version pinning,
  // dropped devDeps, excluded paths, and AGENTS.md / CLAUDE.md
  // parity. Subsumes the older single-target smoke checks above for
  // the rewrite-correctness side of the contract.
  for (const target of ["cloudflare", "node"] as const) {
    test(`scaffold + rename end-to-end (${target})`, async () => {
      // Per-target appName so the two parameterised runs don't collide
      // inside the shared `outRoot` tmpdir.
      const appName = `my-test-app-${target}`;
      const tenant = "my-test-tenant";
      const result = await scaffold({
        projectName: appName,
        target,
        pm: "pnpm",
        tenant,
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      });

      // 1. Top-level package.json:name matches the user input.
      const topPkg = JSON.parse(await readFile(join(result.outDir, "package.json"), "utf8")) as {
        name: string;
        devDependencies?: Record<string, string>;
      };
      expect(topPkg.name).toBe(appName);

      // 2. baerly.config.ts parses (read as text) and reflects the
      //    user-supplied values — and contains NO sentinel residue.
      const config = await readFile(join(result.outDir, "baerly.config.ts"), "utf8");
      expect(config).toContain(`app: "${appName}"`);
      expect(config).toContain(`tenant: "${tenant}"`);
      expect(config).not.toContain("minimal-cloudflare");
      expect(config).not.toContain("minimal-demo");

      // 3. `@baerly/*` workspace deps pinned to a real semver in the
      //    inner apps/server/package.json (top-level package.json
      //    has no `@baerly/*` deps — they all live one level down).
      const innerPkgPath = join(result.outDir, "apps", "server", "package.json");
      const innerPkg = JSON.parse(await readFile(innerPkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const baerlyDep = Object.entries(innerPkg.dependencies ?? {}).find(([k]) =>
        k.startsWith("@baerly/"),
      );
      expect(baerlyDep, "expected at least one @baerly/* dependency").toBeDefined();
      const [, baerlyVersion] = baerlyDep!;
      expect(baerlyVersion).not.toBe("workspace:*");
      expect(baerlyVersion).toMatch(/^\^?\d+\.\d+\.\d+/);

      // 4. `create-baerly` dropped from devDependencies per manifest.
      expect(topPkg.devDependencies?.["create-baerly"]).toBeUndefined();

      // 5. `uint8array-base64.d.ts` excluded per manifest.
      expect(result.filesWritten).not.toContain("uint8array-base64.d.ts");

      // 6. AGENTS.md + CLAUDE.md parity (Codex CLI reads one, Claude
      //    Code reads the other — they MUST be byte-identical).
      const agents = await readFile(join(result.outDir, "AGENTS.md"), "utf8");
      const claude = await readFile(join(result.outDir, "CLAUDE.md"), "utf8");
      expect(claude).toEqual(agents);
    });
  }
});
