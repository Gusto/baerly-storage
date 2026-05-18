import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import { scaffold } from "./scaffold.ts";

// `examples/` (containing `minimal-cloudflare/`, `minimal-node-railway/`,
// `minimal-node-docker/`, and `helpdesk-cloudflare/`) is the templates
// root. The scaffolder's `STARTER_TO_EXAMPLE` map resolves a
// `<target>:<starter>` compound key to the matching example
// directory under this root.
const TEMPLATES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "examples",
);
const EXAMPLE_DIRS = [
  resolve(TEMPLATES_ROOT, "minimal-cloudflare"),
  resolve(TEMPLATES_ROOT, "minimal-node-railway"),
  resolve(TEMPLATES_ROOT, "minimal-node-docker"),
  resolve(TEMPLATES_ROOT, "helpdesk-cloudflare"),
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
    expect(result.filesWritten).toContain("wrangler.jsonc");
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

    const wrangler = await readFile(join(result.outDir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"name": "my-app"');
    expect(wrangler).toContain('"bucket_name": "my-app"');
    expect(wrangler).toContain('"TENANT": "acme"');

    const worker = await readFile(join(result.outDir, "src", "server", "index.ts"), "utf8");
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
    const wrangler = await readFile(join(result.outDir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"r2_buckets":');
    expect(wrangler).toContain('"triggers":');
    expect(wrangler).toContain('"limits":');
    expect(wrangler).toContain('"observability":');
    expect(wrangler).toContain('"name": "prod-app"');
  });

  test.each(["node-railway", "node-docker"] as const)(
    "emits a %s scaffold with the bearerJwt fallback verifier",
    async (target) => {
      // Per-target projectName so the parameterised runs don't
      // collide inside the shared `outRoot` tmpdir.
      const projectName = `svc-a-${target}`;
      const result = await scaffold({
        projectName,
        target,
        pm: "npm",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      });
      expect(result.filesWritten).toContain(join("src", "server", "index.ts"));
      expect(result.filesWritten).not.toContain("wrangler.jsonc");
      expect(result.filesWritten).toContain("AGENTS.md");
      expect(result.filesWritten).toContain("CLAUDE.md");
      const agentsMd = await readFile(join(result.outDir, "AGENTS.md"), "utf8");
      const claudeMd = await readFile(join(result.outDir, "CLAUDE.md"), "utf8");
      expect(claudeMd).toEqual(agentsMd);

      const server = await readFile(join(result.outDir, "src", "server", "index.ts"), "utf8");
      expect(server).toContain("bearerJwt");
      expect(server).toContain("sharedSecret");
      expect(server).toContain(`const APP = "${projectName}"`);

      const config = await readFile(join(result.outDir, "baerly.config.ts"), "utf8");
      expect(config).toContain(`target: "${target}"`);
    },
  );

  it("emits a distroless Dockerfile + healthcheck for node-docker", async () => {
    const result = await scaffold({
      projectName: "prod-docker",
      target: "node-docker",
      pm: "pnpm",
      tenant: "acme",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain("Dockerfile");
    expect(result.filesWritten).toContain("healthcheck.js");
    expect(result.filesWritten).toContain(".dockerignore");
    expect(result.filesWritten).toContain(".env.example");
    expect(result.filesWritten).not.toContain("pm2.config.cjs");
    expect(result.filesWritten).not.toContain(join("systemd", "baerly.service"));

    const dockerfile = await readFile(join(result.outDir, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM gcr.io/distroless/nodejs24-debian12");
    expect(dockerfile).toContain("USER nonroot:nonroot");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('org.opencontainers.image.title="prod-docker"');

    const envExample = await readFile(join(result.outDir, ".env.example"), "utf8");
    expect(envExample).toContain("TENANT=acme");
  });

  it("emits a lean PaaS shape (no Docker) for node-railway", async () => {
    const result = await scaffold({
      projectName: "prod-railway",
      target: "node-railway",
      pm: "pnpm",
      tenant: "acme",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(join("src", "server", "index.ts"));
    expect(result.filesWritten).toContain(".env.example");
    expect(result.filesWritten).not.toContain("Dockerfile");
    expect(result.filesWritten).not.toContain(".dockerignore");
    expect(result.filesWritten).not.toContain("healthcheck.js");
    expect(result.filesWritten).not.toContain("pm2.config.cjs");
    expect(result.filesWritten).not.toContain(join("systemd", "baerly.service"));

    const envExample = await readFile(join(result.outDir, ".env.example"), "utf8");
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
      target: "node-docker",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    await expect(
      scaffold({
        projectName: "exists",
        target: "node-docker",
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

  it("defaults starter to 'minimal' when omitted", async () => {
    const result = await scaffold({
      projectName: "default-starter",
      target: "cloudflare",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    // Minimal scaffold ships wrangler.jsonc at the package root.
    expect(result.filesWritten).toContain("wrangler.jsonc");
  });

  it("rejects an unknown starter", async () => {
    await expect(
      scaffold({
        projectName: "ghost-starter",
        target: "cloudflare",
        // The cast bypasses the type guard so we exercise the runtime check.
        starter: "ghost" as "minimal",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/template not found for target=cloudflare starter=ghost/);
  });

  test.each(["node-railway", "node-docker"] as const)(
    "rejects helpdesk starter on %s",
    async (target) => {
      await expect(
        scaffold({
          projectName: `no-helpdesk-${target}`,
          target,
          starter: "helpdesk",
          templatesRoot: TEMPLATES_ROOT,
          outRoot,
        }),
      ).rejects.toThrow(new RegExp(`template not found for target=${target} starter=helpdesk`));
    },
  );

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
    ).rejects.toThrow(/template not found for target=lambda starter=minimal/);
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
    const skipName = (name: string): boolean => name === "node_modules" || name === "dist";
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
  // target + starter combination with concrete user inputs into a
  // tmpdir and validates the post-substitute invariants the CLI relies
  // on: package.json identity, baerly.config.ts content, @baerly/*
  // version pinning, dropped devDeps, excluded paths, and AGENTS.md /
  // CLAUDE.md parity. Subsumes the older single-target smoke checks
  // above for the rewrite-correctness side of the contract.
  const E2E_CASES = [
    {
      target: "cloudflare",
      starter: undefined,
      sentinels: ["minimal-cloudflare", "minimal-demo"],
      shape: "minimal",
    },
    {
      target: "node-railway",
      starter: undefined,
      sentinels: ["minimal-railway", "minimal-demo"],
      shape: "minimal",
    },
    {
      target: "node-docker",
      starter: undefined,
      sentinels: ["minimal-docker", "minimal-demo"],
      shape: "minimal",
    },
    {
      target: "cloudflare",
      starter: "helpdesk",
      sentinels: ["helpdesk-cloudflare", "helpdesk-demo"],
      shape: "helpdesk",
    },
  ] as const;
  for (const { target, starter, sentinels, shape } of E2E_CASES) {
    const label = starter === undefined ? target : `${target}+${starter}`;
    test(`scaffold + rename end-to-end (${label})`, async () => {
      // Per-case appName so the parameterised runs don't collide
      // inside the shared `outRoot` tmpdir.
      const appName = `my-test-app-${label.replace("+", "-")}`;
      const tenant = "my-test-tenant";
      const result = await scaffold({
        projectName: appName,
        target,
        ...(starter !== undefined && { starter }),
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
      for (const sentinel of sentinels) {
        expect(config).not.toContain(sentinel);
      }

      // 3. `@baerly/*` workspace deps pinned to a real semver. All deps
      //    live at the package root in the flat layout, so we anchor
      //    on `topPkg` directly.
      const topPkgFull = JSON.parse(
        await readFile(join(result.outDir, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const baerlyDep =
        Object.entries(topPkgFull.dependencies ?? {}).find(([k]) => k.startsWith("@baerly/")) ??
        Object.entries(topPkgFull.devDependencies ?? {}).find(([k]) => k.startsWith("@baerly/"));
      expect(baerlyDep, "expected at least one @baerly/* dependency").toBeDefined();
      const [, baerlyVersion] = baerlyDep!;
      expect(baerlyVersion).not.toBe("workspace:*");
      expect(baerlyVersion).toMatch(/^\^?\d+\.\d+\.\d+/);

      // 4. `create-baerly` kept in devDependencies (the emitted
      //    `baerly.config.ts` imports `create-baerly/config`) and
      //    pinned to a real semver alongside the `@baerly/*` deps.
      const createBaerlyVersion = topPkg.devDependencies?.["create-baerly"];
      expect(createBaerlyVersion).toBeDefined();
      expect(createBaerlyVersion).not.toBe("workspace:*");
      expect(createBaerlyVersion).toMatch(/^\^?\d+\.\d+\.\d+/);

      // 5. `uint8array-base64.d.ts` shim shipped — load-bearing for
      //    `tsc -b --noEmit` against workspace-linked @baerly/protocol
      //    until TS proper accepts esnext.typedarrays in --lib.
      expect(result.filesWritten).toContain("uint8array-base64.d.ts");

      // 6. AGENTS.md + CLAUDE.md parity (Codex CLI reads one, Claude
      //    Code reads the other — they MUST be byte-identical).
      const agents = await readFile(join(result.outDir, "AGENTS.md"), "utf8");
      const claude = await readFile(join(result.outDir, "CLAUDE.md"), "utf8");
      expect(claude).toEqual(agents);

      // 7. Helpdesk shape: real React UI shipped at src/web/, with
      //    Vite's `index.html` at the package root.
      if (shape === "helpdesk") {
        expect(result.filesWritten).toContain("index.html");
        expect(result.filesWritten).toContain(join("src", "web", "TicketList.tsx"));
        const html = await readFile(join(result.outDir, "index.html"), "utf8");
        // "Baerly Helpdesk" is deliberate prose, not a slug. The renames
        // manifest only sentinelizes `helpdesk-cloudflare` and
        // `helpdesk-demo`; bare `Helpdesk`/`helpdesk` must survive intact.
        expect(html).toContain("Baerly Helpdesk");
        // The root `package.json:name` already renamed to `appName`
        // above (assertion #1). The flat layout has no separate web
        // package, so there's no `${appName}-web` workspace name to
        // assert here.
      }
    });
  }

  // Flat-shape script-row sanity: the scaffolder doesn't manufacture
  // `package.json:scripts`, it just copies what each example ships.
  // This test pins the contract so any future drift on the example
  // side surfaces here instead of at user-install time.
  test.each([
    { target: "cloudflare" as const, dev: "vite", build: "tsc -b && vite build" },
    { target: "node-railway" as const, dev: "baerly dev", build: "tsc -b && vite build" },
    { target: "node-docker" as const, dev: "baerly dev", build: "tsc -b && vite build" },
  ])("emits flat-shape scripts for $target", async ({ target, dev, build }) => {
    const result = await scaffold({
      projectName: `scripts-${target}`,
      target,
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    const pkg = JSON.parse(await readFile(join(result.outDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.dev).toBe(dev);
    expect(pkg.scripts?.build).toBe(build);
  });
});
