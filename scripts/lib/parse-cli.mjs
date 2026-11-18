import { basename } from "node:path";
import { parseArgs } from "node:util";

/**
 * Strict `util.parseArgs` over `process.argv`. A bad flag prints a one-line
 * usage error and exits 1 instead of throwing a stack trace.
 */
export const parseCliArgs = (config) => {
  try {
    return parseArgs({ args: process.argv.slice(2), strict: true, ...config });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_")) {
      console.error(`${basename(process.argv[1] ?? "script")}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
};
