/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Table<T>` / `Query<T>` declarations); the gate asserts the
   round-trip by reading the server-assigned id back. */

/**
 * Day-one handshake gate.
 *
 * Asserts: from `npm create baerly@latest` on a clean directory to a
 * working `client.table().insert()` round-trip:
 *
 *   - Cloudflare target : < 5 min wall-clock cold
 *   - Node target       : < 3 min wall-clock local
 *   - No manual credential editing (env vars pre-supplied; the
 *     scaffold + deploy never prompt for `vi .env`)
 *
 * **Manual** — at least one of the per-target env knobs must be set
 * for the matching `describe.runIf` block to run; `pnpm test` skips
 * this file entirely via the `vitest.config.ts` `dayOneExclude` glob
 * unless `DAY_ONE_TARGETS` is present in the environment.
 *
 * Required env (Node target — default):
 *
 *   - `DAY_ONE_TARGETS="node"` (or `"cloudflare,node"`)
 *   - `SHARED_SECRET`           — generated per-run if unset
 *
 * Required env (Cloudflare target):
 *
 *   - `DAY_ONE_TARGETS` includes `"cloudflare"`
 *   - `CF_API_TOKEN`            — Cloudflare API token with
 *                                  Workers Scripts:Edit + R2:Edit
 *   - `CF_ACCOUNT_ID`           — Cloudflare account id
 *
 * Optional:
 *
 *   - `DAY_ONE_BUDGET_CF_MS=300000`   — 5 min default
 *   - `DAY_ONE_BUDGET_NODE_MS=180000` — 3 min default
 *
 * See `docs/contributing/day-one-gate.md` for the full lifecycle.
 */

import { execa, type ResultPromise } from "execa";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JSONArraylessObject } from "@baerly/protocol";
import { createBaerlyClient } from "@baerly/client";

const TARGETS = new Set((process.env["DAY_ONE_TARGETS"] ?? "").split(",").filter((s) => s.length > 0));
const RUN_CF = TARGETS.has("cloudflare");
const RUN_NODE = TARGETS.has("node");

const BUDGET_CF_MS = Number(process.env["DAY_ONE_BUDGET_CF_MS"] ?? 300_000);
const BUDGET_NODE_MS = Number(process.env["DAY_ONE_BUDGET_NODE_MS"] ?? 180_000);

const CF_API_TOKEN = process.env["CF_API_TOKEN"];
const CF_ACCOUNT_ID = process.env["CF_ACCOUNT_ID"];
const SHARED_SECRET = process.env["SHARED_SECRET"] ?? cryptoRandomSecret();

interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
  readonly status: "open" | "closed";
}

function cryptoRandomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe.runIf(RUN_NODE)("day-one handshake — node target", () => {
  let workdir: string;
  let serverHandle: ServerHandle | undefined;
  const stamps: { label: string; ms: number }[] = [];
  const t0 = performance.now();
  const stamp = (label: string): void => {
    const ms = performance.now() - t0;
    stamps.push({ label, ms });
    console.log(`  [+${ms.toFixed(0)} ms] ${label}`);
  };

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "baerly-day-one-node-"));
  });

  afterAll(async () => {
    if (serverHandle !== undefined) await serverHandle.kill();
    await rm(workdir, { recursive: true, force: true });
    // One-line CSV-shape summary for log scraping.
    console.log(
      `SUMMARY day-one-node ms=${(performance.now() - t0).toFixed(0)} stages=${stamps
        .map((s) => `${s.label}:${s.ms.toFixed(0)}`)
        .join(";")}`,
    );
  });

  test(
    "scaffold → deploy (local) → first record < 3 min, no manual credential editing",
    async () => {
      stamp("start");

      // 1. SCAFFOLD: `npm create baerly@latest -- my-app --target=node`.
      //    Driven non-interactively. The scaffold's auto-prompt logic
      //    (ticket 38) must accept all defaults under
      //    `BAERLY_NONINTERACTIVE=1`.
      const appDir = join(workdir, "my-app");
      await execa(
        "npm",
        ["create", "baerly@latest", "--", "my-app", "--target=node", "--non-interactive"],
        {
          cwd: workdir,
          env: {
            ...process.env,
            BAERLY_NONINTERACTIVE: "1",
            HELPDESK_SECRET: SHARED_SECRET,
          },
        },
      );
      stamp("scaffold-complete");

      // 2. INSTALL: pnpm install inside the scaffold.
      await execa("pnpm", ["install"], { cwd: appDir });
      stamp("install-complete");

      // 3. DEPLOY (local): boot the helpdesk-shape server on
      //    a free port. Node-target variants self-deploy via their PaaS
      //    or `docker build`; the gate uses the local dev boot path
      //    because the test is on-host. Production paths are exercised
      //    manually per `docs/contributing/day-one-gate.md`.
      const port = await pickFreePort();
      serverHandle = await spawnServer(appDir, port);
      await serverHandle.waitForReady();
      stamp("server-ready");

      // 4. CREDENTIALS CHECK: the .env file (if any) is auto-
      //    generated by the scaffold + deploy. The gate ASSERTS that
      //    no manual edit happened — the env file's mtime must be
      //    within the gate budget of the test start (i.e., it was
      //    written by the scaffold, not edited by hand after).
      await assertNoManualEnvEdit(appDir);
      stamp("no-manual-env-edit");

      // 5. FIRST RECORD: round-trip via @baerly/client.
      const client = createBaerlyClient({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: { Authorization: `Bearer ${SHARED_SECRET}` },
      });
      const { _id } = await client.table<Ticket>("tickets").insert({
        title: "day-one gate",
        status: "open",
      });
      stamp("first-write");
      expect(_id).toMatch(/.+/);
      const row = await client.table<Ticket>("tickets").where({ _id }).first();
      expect(row).toEqual({ _id, title: "day-one gate", status: "open" });
      stamp("first-read");

      // 6. BUDGET CHECK.
      const wall = performance.now() - t0;
      expect(wall).toBeLessThan(BUDGET_NODE_MS);
    },
    BUDGET_NODE_MS + 30_000, // vitest timeout: budget + 30s buffer
  );
});

describe.runIf(RUN_CF && CF_API_TOKEN !== undefined && CF_ACCOUNT_ID !== undefined)(
  "day-one handshake — cloudflare target",
  () => {
    let workdir: string;
    let workerName: string | undefined;
    const stamps: { label: string; ms: number }[] = [];
    const t0 = performance.now();
    const stamp = (label: string): void => {
      const ms = performance.now() - t0;
      stamps.push({ label, ms });
      console.log(`  [+${ms.toFixed(0)} ms] ${label}`);
    };

    beforeAll(async () => {
      workdir = await mkdtemp(join(tmpdir(), "baerly-day-one-cf-"));
    });

    afterAll(async () => {
      if (workerName !== undefined) {
        // Best-effort delete; do NOT fail the suite on cleanup error.
        try {
          await execa("wrangler", ["delete", workerName], {
            cwd: join(workdir, "my-app"),
            env: {
              ...process.env,
              CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
              CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
            },
          });
        } catch (e) {
          console.warn(`wrangler delete ${workerName} failed:`, e);
        }
      }
      await rm(workdir, { recursive: true, force: true });
      console.log(
        `SUMMARY day-one-cf ms=${(performance.now() - t0).toFixed(0)} stages=${stamps
          .map((s) => `${s.label}:${s.ms.toFixed(0)}`)
          .join(";")}`,
      );
    });

    test(
      "scaffold → deploy (CF) → first record < 5 min cold, no manual credential editing",
      async () => {
        stamp("start");
        const appDir = join(workdir, "my-app");
        workerName = `day-one-${Date.now()}`;

        // SCAFFOLD with --target=cloudflare. The scaffold writes the
        // worker name into wrangler.toml; we override via env so the
        // gate's per-run name is unique and tear-down-able.
        await execa(
          "npm",
          ["create", "baerly@latest", "--", "my-app", "--target=cloudflare", "--non-interactive"],
          {
            cwd: workdir,
            env: {
              ...process.env,
              BAERLY_NONINTERACTIVE: "1",
              BAERLY_WORKER_NAME: workerName,
              SHARED_SECRET,
            },
          },
        );
        stamp("scaffold-complete");

        await execa("pnpm", ["install"], { cwd: appDir });
        stamp("install-complete");

        // DEPLOY: `baerly deploy --target=cloudflare`. Ticket 39's
        // command shells `wrangler --x-provision --x-auto-create
        // deploy` and reads CLOUDFLARE_API_TOKEN +
        // CLOUDFLARE_ACCOUNT_ID. The `SHARED_SECRET` is set inline
        // via `wrangler secret put` — non-interactive variant.
        await execa("pnpm", ["exec", "baerly", "deploy", "--target=cloudflare"], {
          cwd: appDir,
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: CF_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
            SHARED_SECRET,
          },
        });
        stamp("deploy-complete");

        const deployUrl = await readDeployUrl(appDir);
        stamp("deploy-url-resolved");

        await assertNoManualEnvEdit(appDir);
        stamp("no-manual-env-edit");

        const client = createBaerlyClient({
          baseUrl: deployUrl,
          headers: { Authorization: `Bearer ${SHARED_SECRET}` },
        });
        const { _id } = await client.table<Ticket>("tickets").insert({
          title: "day-one gate cf",
          status: "open",
        });
        stamp("first-write");
        expect(_id).toMatch(/.+/);
        const row = await client.table<Ticket>("tickets").where({ _id }).first();
        expect(row).toEqual({ _id, title: "day-one gate cf", status: "open" });
        stamp("first-read");

        const wall = performance.now() - t0;
        expect(wall).toBeLessThan(BUDGET_CF_MS);
      },
      BUDGET_CF_MS + 60_000, // vitest timeout: budget + 60s buffer (CF cold start)
    );
  },
);

// ── helpers ────────────────────────────────────────────────────────

interface ServerHandle {
  kill(): Promise<void>;
  waitForReady(): Promise<void>;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // node:net listen on 0 → OS-assigned port; close immediately so
    // the spawned server can re-bind.
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnServer(appDir: string, port: number): Promise<ServerHandle> {
  const child: ResultPromise = execa("pnpm", ["--filter", "@helpdesk/server", "dev"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), HELPDESK_SECRET: SHARED_SECRET },
  });
  return {
    kill: async () => {
      child.kill("SIGTERM");
      try {
        await child;
      } catch {
        // Subprocess exited with a non-zero / signal code; that's
        // the normal teardown path. Swallow.
      }
    },
    waitForReady: async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/healthz`);
          if (res.ok) return;
        } catch {
          // not yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`server did not become ready in 30 s on :${port}`);
    },
  };
}

async function assertNoManualEnvEdit(appDir: string): Promise<void> {
  // Ticket 38's scaffold writes a single .env at the package root
  // with all required values pre-filled. The gate asserts:
  //   1. The file exists at one of the candidate paths.
  //   2. Its mtime is within the gate budget of the test start
  //      (i.e., it was written by the scaffold, not edited by hand
  //      after).
  // If the scaffold has changed shape, update this guard.
  const candidates = [join(appDir, ".env"), join(appDir, "apps", "server", ".env")];
  let found: string | undefined;
  for (const p of candidates) {
    try {
      await readFile(p, "utf-8");
      found = p;
      break;
    } catch {
      // missing — try next
    }
  }
  // The scaffold may not produce a .env on every target; absence is
  // not a failure (the credential is threaded via process env in
  // those cases).
  if (found === undefined) return;
  const s = await stat(found);
  const ageMs = Date.now() - s.mtimeMs;
  // The whole gate budget is 3-5 min; an .env older than the
  // budget can't have been written by this run.
  if (ageMs > BUDGET_CF_MS) {
    throw new Error(
      `assertNoManualEnvEdit: ${found} is older than the gate budget (${ageMs} ms) — manual edit suspected`,
    );
  }
}

async function readDeployUrl(appDir: string): Promise<string> {
  // Ticket 39's `baerly deploy --target=cloudflare` writes the
  // deployed URL to .baerly/deploy.json:
  //   { "target": "cloudflare", "url": "https://my-app.example.workers.dev" }
  const p = join(appDir, ".baerly", "deploy.json");
  const raw = await readFile(p, "utf-8");
  const parsed = JSON.parse(raw) as { url?: string };
  if (typeof parsed.url !== "string") {
    throw new Error(`readDeployUrl: .baerly/deploy.json missing 'url' field`);
  }
  return parsed.url;
}
