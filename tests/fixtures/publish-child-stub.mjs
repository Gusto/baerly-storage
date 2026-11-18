import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const failAt = process.env.PUBLISH_STUB_FAIL;

childProcess.execSync = (command) => {
  process.stderr.write(`STUB_COMMAND:${command}\n`);

  const failed =
    (failAt === "artifacts" && command === "pnpm run verify:artifacts") ||
    (failAt === "packaging" && command === "pnpm run verify:package") ||
    (failAt?.startsWith("publish:") &&
      command.includes("publish") &&
      (failAt === "publish:@gusto/baerly-storage"
        ? command.startsWith("pnpm publish ")
        : command.includes(failAt.slice("publish:".length))));

  if (failed) {
    const error = new Error(`stubbed failure: ${command}`);
    error.stderr = Buffer.from(`stubbed failure: ${command}`);
    throw error;
  }

  if (command.startsWith("pnpm ")) {
    return Buffer.alloc(0);
  }

  throw new Error(`unexpected child command in publish test: ${command}`);
};
syncBuiltinESMExports();
