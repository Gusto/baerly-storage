import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/publish.mjs", import.meta.url));
const STUB = fileURLToPath(new URL("../fixtures/publish-child-stub.mjs", import.meta.url));
const PACKAGES = ["@gusto/baerly-storage", "@gusto/create-baerly-storage"];
const DRY_RUN_COMMANDS = [
  "STUB_COMMAND:pnpm publish --access public --no-git-checks --dry-run",
  "STUB_COMMAND:pnpm --filter @gusto/create-baerly-storage publish --access public --no-git-checks --dry-run",
];

function runPublish(args: string[], failAt?: string) {
  const result = spawnSync(process.execPath, ["--import", STUB, SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PUBLISH_STUB_FAIL: failAt ?? "" },
  });
  return {
    code: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

for (const pkg of PACKAGES) {
  test(`dry-run fails with a diagnostic when ${pkg} simulation fails`, () => {
    const result = runPublish(["--dry-run"], `publish:${pkg}`);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`publish exited non-zero for ${pkg}`);
    expect(result.output).toContain(`${pkg}: publish step failed`);
    for (const command of DRY_RUN_COMMANDS) {
      expect(result.output).toContain(command);
    }
  });
}

test("dry-run succeeds when both package simulations succeed", () => {
  const result = runPublish(["--dry-run"]);

  expect(result.code).toBe(0);
  for (const command of DRY_RUN_COMMANDS) {
    expect(result.output).toContain(command);
  }
  expect(result.output).not.toContain("STUB_COMMAND:npm ");
});

for (const failure of ["artifacts", "packaging"]) {
  test(`${failure} failure aborts before either package publish`, () => {
    const result = runPublish(["--dry-run"], failure);

    expect(result.code).toBe(1);
    expect(result.output).toContain("RELEASE ABORTED");
    expect(result.output).not.toContain("STUB_COMMAND:pnpm publish");
    expect(result.output).not.toContain(
      "STUB_COMMAND:pnpm --filter @gusto/create-baerly-storage publish",
    );
  });
}

test("real publish mode retains both package commands and success status", () => {
  const result = runPublish([]);

  expect(result.code).toBe(0);
  expect(result.output).toContain("STUB_COMMAND:pnpm publish --access public --no-git-checks\n");
  expect(result.output).toContain(
    "STUB_COMMAND:pnpm --filter @gusto/create-baerly-storage publish --access public --no-git-checks\n",
  );
  expect(result.output).toContain("Both packages published.");
});

// A mistyped flag must never fall through to a real publish.
for (const args of [["--dryrun"], ["--dry-run=true"], ["--otp=123456"], ["extra"]]) {
  test(`rejects ${args.join(" ")} before running anything`, () => {
    const result = runPublish(args);

    expect(result.code).toBe(1);
    expect(result.output).toContain("RELEASE ABORTED");
    expect(result.output).not.toContain("STUB_COMMAND:");
  });
}
