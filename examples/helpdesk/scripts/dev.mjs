// Boot Vite as a child so we can convert SIGINT (Ctrl-C) into a 0 exit.
// Without this, pnpm sees vite's signal-exit (130) and prints
// `[ELIFECYCLE] Command failed.`, which is noise on every clean shutdown.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const viteBin = resolve(here, "..", "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [viteBin, ...process.argv.slice(2)], {
  stdio: "inherit",
});

const forward = (signal) => {
  try {
    child.kill(signal);
  } catch {}
};

process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal === "SIGINT" || signal === "SIGTERM") {
    process.exit(0);
  }
  process.exit(code ?? 0);
});
