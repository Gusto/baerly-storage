/**
 * CLI test for `baerly init`. Drives `runInit` programmatically so
 * the run stays in-process — no citty `runMain` / `process.exit`
 * collision with vitest.
 *
 * Each test chdir's into a fresh tmp directory so file writes don't
 * pollute the repo. The cwd is restored on teardown.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadAppConfig } from "./config.ts";
import { runInit } from "./init.ts";

const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
};

describe("baerly init", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    const made = await mkdtemp(join(tmpdir(), "baerly-init-"));
    originalCwd = process.cwd();
    process.chdir(made);
    // On macOS, /tmp resolves to /private/tmp; process.cwd() canonicalises
    // symlinks, while mkdtemp returns the un-canonicalised path. Re-read
    // through process.cwd() so file paths emitted by the CLI compare equal.
    root = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test("writes baerly.config.ts with the canonical template body (node-railway)", async () => {
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInit(["--app=demo", "--tenant=acme", "--target=node-railway"]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const written = await readFile(join(root, "baerly.config.ts"), "utf8");
    expect(written).toBe(
      `import { defineConfig } from "create-baerly/config";

export default defineConfig({
  app: "demo",
  tenant: "acme",
  target: "node-railway",
});
`,
    );
    // Text mode emits nothing on stdout.
    expect(stdout.captured.join("")).toBe("");
  });

  test("writes baerly.config.ts with the canonical template body (node-docker)", async () => {
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInit(["--app=demo", "--tenant=acme", "--target=node-docker"]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const written = await readFile(join(root, "baerly.config.ts"), "utf8");
    expect(written).toBe(
      `import { defineConfig } from "create-baerly/config";

export default defineConfig({
  app: "demo",
  tenant: "acme",
  target: "node-docker",
});
`,
    );
    // Text mode emits nothing on stdout.
    expect(stdout.captured.join("")).toBe("");
  });

  test("defaults tenant=default and target=cloudflare", async () => {
    const exitCode = await runInit(["--app=demo"]);
    expect(exitCode).toBe(0);
    const written = await readFile(join(root, "baerly.config.ts"), "utf8");
    expect(written).toContain('tenant: "default"');
    expect(written).toContain('target: "cloudflare"');
  });

  test("refuses without --app (InvalidConfig, exit 1)", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInit([]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(existsSync(join(root, "baerly.config.ts"))).toBe(false);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("refuses a bad target (InvalidConfig, exit 1)", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInit(["--app=demo", "--target=node"]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(existsSync(join(root, "baerly.config.ts"))).toBe(false);
    expect(stderr.captured.join("")).toMatch(
      /--target must be "cloudflare", "node-railway", or "node-docker"/,
    );
  });

  test("refuses to overwrite without --force (InvalidConfig, exit 1)", async () => {
    await writeFile(join(root, "baerly.config.ts"), "// already present\n", "utf8");
    const exitCode = await runInit(["--app=demo"]);
    expect(exitCode).toBe(1);
    const text = await readFile(join(root, "baerly.config.ts"), "utf8");
    expect(text).toBe("// already present\n");
  });

  test("overwrites when --force is passed", async () => {
    await writeFile(join(root, "baerly.config.ts"), "// stale\n", "utf8");
    const exitCode = await runInit(["--app=demo", "--force"]);
    expect(exitCode).toBe(0);
    const text = await readFile(join(root, "baerly.config.ts"), "utf8");
    expect(text).toContain('app: "demo"');
    expect(text).not.toContain("// stale");
  });

  test("--json emits a structured success envelope on stdout", async () => {
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInit(["--app=demo", "--json"]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { command: string; status: string; path: string; app: string };
    };
    expect(envelope.result.command).toBe("init");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.app).toBe("demo");
    expect(envelope.result.path).toBe(join(root, "baerly.config.ts"));
  });

  test("rejects unknown flag with exit 1", async () => {
    const exitCode = await runInit(["--app=demo", "--unknown=oops"]);
    expect(exitCode).toBe(1);
  });
});

describe("emits configs that load through loadAppConfig", () => {
  // loadAppConfig dynamic-imports the .ts file, which references
  // `create-baerly/config`. Module resolution only succeeds from a
  // directory whose ancestor node_modules has that package wired —
  // i.e., one of the workspace example dirs. We stage the temp
  // workdir under examples/minimal-cloudflare/ so the import path
  // resolves through pnpm's hoist, then clean up on teardown.
  const exampleRoot = join(__dirname, "..", "..", "..", "examples", "minimal-cloudflare");
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    const made = await mkdtemp(join(exampleRoot, ".baerly-init-roundtrip-"));
    originalCwd = process.cwd();
    process.chdir(made);
    root = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  for (const target of ["cloudflare", "node-railway", "node-docker"] as const) {
    test(`round-trips --target=${target}`, async () => {
      const exitCode = await runInit(["--app=demo", `--target=${target}`]);
      expect(exitCode).toBe(0);
      const cfg = await loadAppConfig(root);
      expect(cfg.app).toBe("demo");
      expect(cfg.tenant).toBe("default");
      expect(cfg.target).toBe(target);
    });
  }
});
