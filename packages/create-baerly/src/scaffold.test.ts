import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scaffold } from "./scaffold.ts";

// `examples/` (containing `minimal-cloudflare/`, `minimal-node/`, and
// `helpdesk-cloudflare/`) is the templates root. The scaffolder's
// `STARTER_TO_EXAMPLE` map resolves a `<target>:<starter>` compound
// key to the matching example directory under this root.
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
  resolve(TEMPLATES_ROOT, "helpdesk-cloudflare"),
];

// `packages/create-baerly/templates/addons/` carries the opt-in add-on
// trees layered on top of the base scaffold via `withAddons`.
const ADDONS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", "addons");

describe("scaffold", () => {
  let outRoot: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "create-baerly-"));
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  test("emits a cloudflare scaffold with substituted placeholders", async () => {
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
    expect(worker).toContain("tenantPrefix: env.TENANT");
  });

  // First-touch DX: scaffolder seeds a working `.dev.vars` (cloudflare)
  // / `.env` (node) so `pnpm dev` succeeds without a manual cp step.
  // Both files are gitignored by the template, so the seeded dev secret
  // stays local. Locking this contract per target prevents accidental
  // regression of the zero-touch onboarding flow.
  test("cloudflare scaffold seeds .dev.vars from .dev.vars.example", async () => {
    const result = await scaffold({
      projectName: "seeded-cf",
      target: "cloudflare",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(".dev.vars.example");
    expect(result.filesWritten).toContain(".dev.vars");
    const example = await readFile(join(result.outDir, ".dev.vars.example"), "utf8");
    const seeded = await readFile(join(result.outDir, ".dev.vars"), "utf8");
    expect(seeded).toEqual(example);
    expect(seeded).toContain("SHARED_SECRET=dev-shared-secret");
  });

  test("helpdesk-cloudflare scaffold also seeds .dev.vars", async () => {
    const result = await scaffold({
      projectName: "seeded-helpdesk",
      target: "cloudflare",
      starter: "helpdesk",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(".dev.vars.example");
    expect(result.filesWritten).toContain(".dev.vars");
    const seeded = await readFile(join(result.outDir, ".dev.vars"), "utf8");
    expect(seeded).toContain("SHARED_SECRET=dev-shared-secret");
  });

  test("node scaffold seeds .env from .env.example", async () => {
    const result = await scaffold({
      projectName: "seeded-node",
      target: "node",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(".env.example");
    expect(result.filesWritten).toContain(".env");
    const example = await readFile(join(result.outDir, ".env.example"), "utf8");
    const seeded = await readFile(join(result.outDir, ".env"), "utf8");
    expect(seeded).toEqual(example);
    expect(seeded).toContain("SHARED_SECRET=dev-shared-secret");
  });

  test("emits a production-shape wrangler.jsonc for cloudflare", async () => {
    const result = await scaffold({
      projectName: "prod-app",
      target: "cloudflare",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    const wrangler = await readFile(join(result.outDir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"r2_buckets":');
    expect(wrangler).toContain('"limits":');
    expect(wrangler).toContain('"observability":');
    expect(wrangler).toContain('"name": "prod-app"');
  });

  test("emits a node scaffold with the bearerJwt fallback verifier", async () => {
    const projectName = `svc-a-node`;
    const result = await scaffold({
      projectName,
      target: "node",
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
    expect(config).toContain(`target: "node"`);
  });

  test("target=node by default emits no Dockerfile / healthcheck / .dockerignore", async () => {
    const result = await scaffold({
      projectName: "no-docker-default",
      target: "node",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      addonsRoot: ADDONS_ROOT,
      outRoot,
    });
    expect(result.filesWritten).not.toContain("Dockerfile");
    expect(result.filesWritten).not.toContain("healthcheck.js");
    expect(result.filesWritten).not.toContain(".dockerignore");
  });

  test("target=node + withAddons=[docker] emits addon files with appName-substituted LABELs", async () => {
    const projectName = "yes-docker";
    const result = await scaffold({
      projectName,
      target: "node",
      pm: "pnpm",
      withAddons: ["docker"],
      templatesRoot: TEMPLATES_ROOT,
      addonsRoot: ADDONS_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain("Dockerfile");
    expect(result.filesWritten).toContain("healthcheck.js");
    expect(result.filesWritten).toContain(".dockerignore");

    const dockerfile = await readFile(join(result.outDir, "Dockerfile"), "utf8");
    // The addon Dockerfile carries the literal `minimal-node` sentinel
    // (the appName value from the host manifest); the substituter
    // rewrites it to the user's projectName at copy time.
    expect(dockerfile).toContain(`LABEL org.opencontainers.image.title="${projectName}"`);
    expect(dockerfile).toContain(
      `LABEL org.opencontainers.image.source="https://github.com/your-org/${projectName}"`,
    );
    expect(dockerfile).not.toContain("minimal-node");
  });

  test("rejects an unknown add-on directory", async () => {
    await expect(
      scaffold({
        projectName: "ghost-addon",
        target: "node",
        pm: "pnpm",
        // The cast bypasses the type guard so we exercise the runtime
        // check (the CLI's parser catches this earlier in normal use).
        withAddons: ["ghost" as "docker"],
        templatesRoot: TEMPLATES_ROOT,
        addonsRoot: ADDONS_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/add-on directory not found.*addon=ghost/);
  });

  test("rejects projectName with disallowed characters", async () => {
    await expect(
      scaffold({
        projectName: "Invalid Name!",
        target: "cloudflare",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/projectName must be lowercase/);
  });

  test("rejects an empty projectName", async () => {
    await expect(
      scaffold({
        projectName: "",
        target: "cloudflare",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/projectName must be non-empty/);
  });

  test("refuses to overwrite a non-empty directory", async () => {
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

  test("returns the correct nextSteps for each detected PM", async () => {
    const r = await scaffold({
      projectName: "pm-test",
      target: "cloudflare",
      pm: "yarn",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(r.nextSteps).toEqual(["cd pm-test", "yarn install", "yarn dev"]);
  });

  test("defaults starter to 'minimal' when omitted", async () => {
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

  test("rejects an unknown starter", async () => {
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

  test("rejects helpdesk starter on node", async () => {
    await expect(
      scaffold({
        projectName: `no-helpdesk-node`,
        target: "node",
        starter: "helpdesk",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      }),
    ).rejects.toThrow(/template not found for target=node starter=helpdesk/);
  });

  test("rejects an unknown target template", async () => {
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

  // Drift sentinel: a tsconfig referencing `@types/X` (via the
  // `types: ["X", ...]` whitelist) without the matching devDep in
  // the same example's package.json fails `tsc -b` on a fresh
  // scaffold with TS2688: "Cannot find type definition file for X".
  // The monorepo masks this — `@types/node` is hoisted by pnpm — so
  // the failure only surfaces for users running `pnpm create baerly`
  // outside this repo. Lock the contract here.
  test("tsconfig types[] entries are covered by local devDependencies", async () => {
    type Pkg = { devDependencies?: Record<string, string> };
    type Tsc = { compilerOptions?: { types?: string[] } };
    const findings: string[] = [];
    for (const dir of EXAMPLE_DIRS) {
      const pkgJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Pkg;
      const devDeps = pkgJson.devDependencies ?? {};
      const entries = await readdir(dir);
      const tsconfigs = entries.filter((n) => n.startsWith("tsconfig") && n.endsWith(".json"));
      for (const name of tsconfigs) {
        const tsc = JSON.parse(await readFile(join(dir, name), "utf8")) as Tsc;
        for (const entry of tsc.compilerOptions?.types ?? []) {
          // TS's `types[]` entries are package specifiers: `node`,
          // `@cloudflare/workers-types`, `vite/client`. Reduce to the
          // owning package name, then accept either that package or
          // `@types/<pkg>` (the DefinitelyTyped convention) in devDeps.
          const parts = entry.split("/");
          const owner = entry.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
          const ok = owner in devDeps || `@types/${owner}` in devDeps;
          if (!ok) {
            findings.push(
              `${relative(TEMPLATES_ROOT, dir)}/${name}: "${entry}" (need devDep "${owner}" or "@types/${owner}")`,
            );
          }
        }
      }
    }
    expect(
      findings,
      `tsconfig types[] entries missing a devDependency: ${findings.join(", ")}`,
    ).toEqual([]);
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
        if (skipName(ent.name)) {
          continue;
        }
        const relEnt = rel === "" ? ent.name : join(rel, ent.name);
        if (skipRel(relEnt)) {
          continue;
        }
        if (ent.isDirectory()) {
          await walk(root, relEnt, hits);
          continue;
        }
        if (!ent.isFile()) {
          continue;
        }
        const st = await stat(join(root, relEnt));
        // Treat anything > 1 MiB as binary — examples don't ship
        // large blobs but a guard keeps the walk fast under churn.
        if (st.size > 1024 * 1024) {
          continue;
        }
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
    for (const dir of EXAMPLE_DIRS) {
      await walk(dir, "", hits);
    }
    expect(hits, `unexpected {{placeholder}} substrings in examples: ${hits.join(", ")}`).toEqual(
      [],
    );
  });

  // End-to-end scaffold + rename. Drives the scaffolder for each
  // target + starter combination with concrete user inputs into a
  // tmpdir and validates the post-substitute invariants the CLI relies
  // on: package.json identity, baerly.config.ts content, baerly-storage
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
      target: "node",
      starter: undefined,
      sentinels: ["minimal-node", "minimal-demo"],
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

      // 3. `baerly-storage` workspace dep pinned to a real semver. All deps
      //    live at the package root in the flat layout, so we anchor
      //    on `topPkg` directly.
      const topPkgFull = JSON.parse(
        await readFile(join(result.outDir, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const baerlyStorageVersion = topPkgFull.dependencies?.["baerly-storage"];
      expect(baerlyStorageVersion, "expected baerly-storage in dependencies").toBeDefined();
      expect(baerlyStorageVersion).not.toBe("workspace:*");
      expect(baerlyStorageVersion).toMatch(/^\^?\d+\.\d+\.\d+/);

      // 4. `create-baerly` is absent from devDependencies. The emitted
      //    `baerly.config.ts` imports `baerly-storage/config`; the
      //    scaffolder is one-shot.
      expect(topPkg.devDependencies?.["create-baerly"]).toBeUndefined();

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

  // Pin the postinstall-allowlist contract. Scaffolded apps inherit
  // `packageManager: pnpm@11.x`, whose strict-builds gate exits with
  // `ERR_PNPM_IGNORED_BUILDS` unless the deps with install scripts
  // are listed in `pnpm-workspace.yaml#allowBuilds`. pnpm 11 reads
  // the map only from that file — `package.json#pnpm.*` is no longer
  // honoured. If any template drops the yaml or strips an expected
  // key, this fails before it reaches a user's terminal.
  test.each([
    {
      target: "cloudflare" as const,
      starter: undefined,
      expected: { esbuild: "true", workerd: "true", sharp: "false" },
    },
    {
      target: "cloudflare" as const,
      starter: "helpdesk" as const,
      expected: { esbuild: "true", workerd: "true", sharp: "false" },
    },
    {
      target: "node" as const,
      starter: undefined,
      expected: { esbuild: "true" },
    },
  ])(
    "scaffolded $target/$starter ships pnpm-workspace.yaml with the expected allowBuilds map",
    async ({ target, starter, expected }) => {
      const label = starter === undefined ? target : `${target}-${starter}`;
      const result = await scaffold({
        projectName: `ws-${label}`,
        target,
        ...(starter !== undefined && { starter }),
        pm: "pnpm",
        templatesRoot: TEMPLATES_ROOT,
        outRoot,
      });
      expect(result.filesWritten).toContain("pnpm-workspace.yaml");
      const ws = await readFile(join(result.outDir, "pnpm-workspace.yaml"), "utf8");
      expect(ws).toMatch(/^allowBuilds\s*:/m);
      for (const [pkg, value] of Object.entries(expected)) {
        // Match `<pkg>: true|false` under any indentation.
        expect(ws).toMatch(new RegExp(`^\\s+${pkg}\\s*:\\s*${value}\\s*$`, "m"));
      }
    },
  );

  // Flat-shape script-row sanity: the scaffolder doesn't manufacture
  // `package.json:scripts`, it just copies what each example ships.
  // This test pins the contract so any future drift on the example
  // side surfaces here instead of at user-install time.
  test.each([
    { target: "cloudflare" as const, dev: "vite", build: "tsc -b && vite build" },
    { target: "node" as const, dev: "vite", build: "tsc -b && vite build" },
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
    expect(pkg.scripts?.["dev"]).toBe(dev);
    expect(pkg.scripts?.["build"]).toBe(build);
  });

  // Drift sentinel: vitest is the project-wide test runner (CLAUDE.md +
  // every scaffold's AGENTS.md says so). Agents zero-shotting a
  // scaffolded app start by running `pnpm test`. If a scaffold ships
  // neither the dep nor a `test` script nor a standalone
  // `vitest.config.ts`, `pnpm test` either errors with "command not
  // found" or — on Cloudflare scaffolds — auto-loads `vite.config.ts`
  // and collides with the Cloudflare Vite plugin
  // (`The following environment options are incompatible…`). Pin the
  // three pieces of the contract here so a future scaffold edit that
  // drops one fails before it reaches a user's terminal.
  test.each([
    { target: "cloudflare" as const, starter: undefined },
    { target: "cloudflare" as const, starter: "helpdesk" as const },
    { target: "node" as const, starter: undefined },
  ])("scaffolded $target/$starter ships vitest wired end-to-end", async ({ target, starter }) => {
    const label = starter === undefined ? target : `${target}-${starter}`;
    const result = await scaffold({
      projectName: `vitest-${label}`,
      target,
      ...(starter !== undefined && { starter }),
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    const pkg = JSON.parse(await readFile(join(result.outDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.["test"]).toMatch(/^vitest run/);
    expect(pkg.devDependencies?.["vitest"]).toBeDefined();
    expect(result.filesWritten).toContain("vitest.config.ts");
    // The standalone config must NOT re-import `vite.config.ts` — the
    // whole point is to keep the Cloudflare plugin out of vitest's
    // pipeline on CF scaffolds and keep startup time minimal on Node.
    const vitestConfig = await readFile(join(result.outDir, "vitest.config.ts"), "utf8");
    expect(vitestConfig).not.toMatch(/from\s+["']\.\/vite\.config/);
  });

  test("cloudflare scaffold ships a wired notes-collection example in main.ts", async () => {
    const result = await scaffold({
      projectName: "wired-cf",
      target: "cloudflare",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(join("src", "web", "main.ts"));
    const mainTs = await readFile(join(result.outDir, "src", "web", "main.ts"), "utf8");
    // Round-trip wired example must reach the DB on first load.
    expect(mainTs).toContain('.table<Note>("notes")');
    expect(mainTs).toContain(".all()");
    expect(mainTs).toContain(".insert(");
    // Regression: no more `void client;` standalone no-op placeholder.
    expect(mainTs).not.toContain("void client;");

    const config = await readFile(join(result.outDir, "baerly.config.ts"), "utf8");
    expect(config).toContain("notes:");
  });

  test("node scaffold ships a wired notes-collection example in main.ts", async () => {
    const result = await scaffold({
      projectName: "wired-node",
      target: "node",
      pm: "pnpm",
      templatesRoot: TEMPLATES_ROOT,
      outRoot,
    });
    expect(result.filesWritten).toContain(join("src", "web", "main.ts"));
    const mainTs = await readFile(join(result.outDir, "src", "web", "main.ts"), "utf8");
    expect(mainTs).toContain('.table<Note>("notes")');
    expect(mainTs).toContain(".all()");
    expect(mainTs).toContain(".insert(");
    // Regression: no more `void client;` standalone no-op placeholder.
    expect(mainTs).not.toContain("void client;");
    const config = await readFile(join(result.outDir, "baerly.config.ts"), "utf8");
    expect(config).toContain("notes:");
  });
});
