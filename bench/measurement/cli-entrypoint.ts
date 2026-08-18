import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runAsCliEntrypoint(
  moduleUrl: string,
  main: () => Promise<number>,
): Promise<void> {
  const isCli =
    process.argv[1] !== undefined && fileURLToPath(moduleUrl) === resolve(process.argv[1]!);
  if (isCli) {
    process.exitCode = await main();
  }
}
