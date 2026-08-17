// Tests for scripts/lib/quiet-spawn.mjs — the shared "run a command, silence
// it on success, replay it on failure" helper behind `build:agent`,
// `bundle-sizes`, and the `prepare` hook's build.
//
// spawnQuiet calls process.exit, so each case runs it inside a child node
// process and asserts on that child's exit code and streams. The contract
// under test is the one an agent depends on: a green run prints nothing, and a
// failed run NEVER exits without a diagnostic. The helper merges the command's
// two streams into one capture, so the replay lands wholly on stdout and only
// the helper's own diagnostic line goes to stderr.
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

  test("replays merged output and the exit code on failure", () => {
    const child = runInChild(process.execPath, [
      "-e",
      "console.log('on stdout'); console.error('on stderr'); process.exit(3)",
    ]);

    expect(child.status).toBe(3);
    expect(child.stdout).toContain("on stdout");
    expect(child.stdout).toContain("on stderr");
    expect(child.stderr).toContain("exited with status 3");
  });

  test("replays interleaved stdout and stderr in their original order", () => {
    // A two-pipe capture replays all of stdout and then all of stderr, which
    // for `pnpm build` prints rolldown's error — on stderr — after the pnpm
    // recap of it on stdout. fs.writeSync rather than console.log so the
    // grandchild's writes are synchronous and its process.exit can't truncate
    // them.
    const child = runInChild(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs')",
        "fs.writeSync(1, '1\\n')",
        "fs.writeSync(2, '2\\n')",
        "fs.writeSync(1, '3\\n')",
        "fs.writeSync(2, '4\\n')",
        "process.exitCode = 1",
      ].join("; "),
    ]);

    expect(child.status).toBe(1);
    const positions = ["1", "2", "3", "4"].map((line) => child.stdout.indexOf(line));
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(positions[0]).toBeGreaterThanOrEqual(0);
  });

  test("reports a spawn failure that produced no output", () => {
    // ENOENT leaves status null and the capture empty, so the replay has
    // nothing to print — without an explicit diagnostic the caller sees a bare
    // exit 1 and no way to tell what went wrong.
    const child = runInChild("baerly-no-such-command", ["run", "build"]);

    expect(child.status).toBe(1);
    expect(child.stderr).toContain("baerly-no-such-command");
  });

  test("reports a signal kill that produced no output", () => {
    const child = runInChild(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);

    expect(child.status).toBe(1);
    expect(child.stderr).toContain("SIGKILL");
  });

  test("reports a nonzero exit that produced no output", () => {
    const child = runInChild(process.execPath, ["-e", "process.exit(7)"]);

    expect(child.status).toBe(7);
    expect(child.stderr).toContain("exited with status 7");
  });
});
