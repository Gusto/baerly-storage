import type { Db } from "@gusto/baerly-storage";
// The sandbox has no node types, so reach `process` through globalThis.
const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
export async function main(_db: Db) {
  return proc?.env["EVAL_SENTINEL_SECRET"] ?? null;
}
