import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/publish.mjs", import.meta.url));
const STUB = fileURLToPath(new URL("../fixtures/publish-child-stub.mjs", import.meta.url));
const VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version as string;
const PACKAGES = ["@gusto/baerly-storage", "@gusto/create-baerly-storage"];
const TARBALLS = [
  `gusto-baerly-storage-${VERSION}.tgz`,
  `gusto-create-baerly-storage-${VERSION}.tgz`,
];
const DRY_RUN_COMMANDS = [
  "STUB_COMMAND:pnpm publish --access public --no-git-checks --dry-run",
  "STUB_COMMAND:pnpm --filter @gusto/create-baerly-storage publish --access public --no-git-checks --dry-run",
];
const TAG_RUN = { GITHUB_ACTIONS: "true", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${VERSION}` };

function runPublish(args: string[], opts: { failAt?: string; env?: Record<string, string> } = {}) {
  // The suite itself may run in GitHub Actions; start from a non-CI env.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["GITHUB_ACTIONS"];
  delete env["GITHUB_REF_TYPE"];
  delete env["GITHUB_REF_NAME"];
  const result = spawnSync(process.execPath, ["--import", STUB, SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...env, PUBLISH_STUB_FAIL: opts.failAt ?? "", ...opts.env },
  });
  return {
    code: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("--dry-run", () => {
  for (const pkg of PACKAGES) {
    test(`fails with a diagnostic when ${pkg} simulation fails`, () => {
      const result = runPublish(["--dry-run"], { failAt: `publish:${pkg}` });

      expect(result.code).toBe(1);
      expect(result.output).toContain(`publish exited non-zero for ${pkg}`);
      expect(result.output).toContain(`${pkg}: publish step failed`);
      for (const command of DRY_RUN_COMMANDS) {
        expect(result.output).toContain(command);
      }
    });
  }

  test("succeeds when both package simulations succeed", () => {
    const result = runPublish(["--dry-run"]);

    expect(result.code).toBe(0);
    for (const command of DRY_RUN_COMMANDS) {
      expect(result.output).toContain(command);
    }
    expect(result.output).not.toContain("--provenance");
    expect(result.output).not.toContain("STUB_COMMAND:npm ");
  });

  for (const failure of ["artifacts", "packaging"]) {
    test(`${failure} failure aborts before either package publish`, () => {
      const result = runPublish(["--dry-run"], { failAt: failure });

      expect(result.code).toBe(1);
      expect(result.output).toContain("RELEASE ABORTED");
      expect(result.output).not.toMatch(/STUB_COMMAND:pnpm (?:[^\n]* )?publish /);
    });
  }
});

describe("--pack", () => {
  test("gates, then packs both packages into the directory", () => {
    const result = runPublish([`--pack=${dir}`]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("STUB_COMMAND:pnpm run verify:package");
    expect(result.output).toContain(`STUB_COMMAND:pnpm pack --pack-destination "${dir}"`);
    expect(result.output).toContain(
      `STUB_COMMAND:pnpm --filter @gusto/create-baerly-storage pack --pack-destination "${dir}"`,
    );
    expect(result.output).not.toMatch(/STUB_COMMAND:pnpm (?:[^\n]* )?publish /);
    expect(readdirSync(dir).toSorted()).toEqual(TARBALLS);
  });

  test("packaging failure aborts before packing", () => {
    const result = runPublish([`--pack=${dir}`], { failAt: "packaging" });

    expect(result.code).toBe(1);
    expect(result.output).toContain("RELEASE ABORTED");
    expect(result.output).not.toContain(" pack --pack-destination");
  });

  test("fails when pack writes no tarball", () => {
    const result = runPublish([`--pack=${dir}`], { failAt: "pack-missing" });

    expect(result.code).toBe(1);
    expect(result.output).toContain("pack did not write");
  });
});

describe("--publish", () => {
  const writeTarballs = (names: readonly string[]) => {
    for (const name of names) {
      writeFileSync(join(dir, name), "");
    }
  };

  test("publishes both tarballs with --provenance, without gates or a build", () => {
    writeTarballs(TARBALLS);
    const result = runPublish([`--publish=${dir}`], { env: TAG_RUN });

    expect(result.code).toBe(0);
    for (const name of TARBALLS) {
      expect(result.output).toContain(
        `STUB_COMMAND:pnpm publish "${join(dir, name)}" --provenance --access public --no-git-checks\n`,
      );
    }
    expect(result.output).not.toContain("verify:");
    expect(result.output).toContain("Both packages published.");
  });

  // A laptop with an npm token in ~/.npmrc must not be able to publish.
  for (const [label, env] of [
    ["outside GitHub Actions", { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${VERSION}` }],
    ["on a branch run", { ...TAG_RUN, GITHUB_REF_TYPE: "branch" }],
  ] as const) {
    test(`refuses ${label}`, () => {
      writeTarballs(TARBALLS);
      const result = runPublish([`--publish=${dir}`], { env });

      expect(result.code).toBe(1);
      expect(result.output).toContain("RELEASE ABORTED");
      expect(result.output).not.toContain("STUB_COMMAND:");
    });
  }

  for (const [label, names] of [
    ["a tarball is missing", TARBALLS.slice(0, 1)],
    ["an extra tarball is present", [...TARBALLS, "gusto-other-1.0.0.tgz"]],
    ["the tarballs are for another version", ["gusto-baerly-storage-0.0.1.tgz"]],
  ] as const) {
    test(`refuses when ${label}`, () => {
      writeTarballs(names);
      const result = runPublish([`--publish=${dir}`], { env: TAG_RUN });

      expect(result.code).toBe(1);
      expect(result.output).toContain("must hold exactly");
      expect(result.output).not.toContain("STUB_COMMAND:");
    });
  }

  test("reports a failed package publish", () => {
    writeTarballs(TARBALLS);
    const result = runPublish([`--publish=${dir}`], {
      env: TAG_RUN,
      failAt: "publish:@gusto/create-baerly-storage",
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("@gusto/create-baerly-storage: publish step failed");
    expect(result.output).toContain("RELEASE INCOMPLETE");
  });
});

// A mistyped or missing mode must never fall through to a publish.
for (const args of [
  [],
  ["--dryrun"],
  ["--dry-run=true"],
  ["--otp=123456"],
  ["extra"],
  ["--pack"],
  ["--dry-run", "--pack=out"],
]) {
  test(`rejects [${args.join(" ")}] before running anything`, () => {
    const result = runPublish(args, { env: TAG_RUN });

    expect(result.code).toBe(1);
    expect(result.output).toContain("RELEASE ABORTED");
    expect(result.output).not.toContain("STUB_COMMAND:");
  });
}
