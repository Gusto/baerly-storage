// Tests for scripts/lib/quiet-spawn.mjs — the shared "run a command, silence
// it on success, replay it on failure" helper behind `build:agent`,
// `bundle-sizes`, and the `prepare` hook's build.
//
// spawnQuiet calls process.exit, so each case runs it inside a child node
// process and asserts on that child's exit code and streams. The contract
// under test is the one an agent depends on: a green run prints nothing, and a
// failed run NEVER exits without a diagnostic.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HELPER = fileURLToPath(new URL("../../scripts/lib/quiet-spawn.mjs", import.meta.url));

function runInChild(cmd: string, args: readonly string[]) {
  const script = `import { spawnQuiet } from ${JSON.stringify(HELPER)};
spawnQuiet(${JSON.stringify(cmd)}, ${JSON.stringify(args)});`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
}

describe("spawnQuiet", () => {
  test("discards output of a successful command", () => {
    const child = runInChild(process.execPath, [
      "-e",
      "console.log('build noise'); console.error('more noise')",
    ]);

    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
  });

  test("replays both streams and the exit code on failure", () => {
    const child = runInChild(process.execPath, [
      "-e",
      "console.log('on stdout'); console.error('on stderr'); process.exit(3)",
    ]);

    expect(child.status).toBe(3);
    expect(child.stdout).toContain("on stdout");
    expect(child.stderr).toContain("on stderr");
  });

  test("reports a spawn failure that produced no output", () => {
    // ENOENT leaves status null and both captured streams undefined, so the
    // replay has nothing to print — without an explicit diagnostic the caller
    // sees a bare exit 1 and no way to tell what went wrong.
    const child = runInChild("baerly-no-such-command", ["run", "build"]);

    expect(child.status).toBe(1);
    expect(child.stderr).toContain("baerly-no-such-command");
  });

  test("reports a signal kill that produced no output", () => {
    const child = runInChild(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);

    expect(child.status).toBe(1);
    expect(child.stderr).toContain("SIGKILL");
  });
});
