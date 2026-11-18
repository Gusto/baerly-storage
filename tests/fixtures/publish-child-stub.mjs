import childProcess from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const failAt = process.env.PUBLISH_STUB_FAIL;

// `pnpm pack --pack-destination "<dir>"` writes the tarball the real
// command would, so the script's post-pack check sees it.
const fakePack = (command) => {
  const dest = command.match(/--pack-destination "([^"]+)"/)?.[1];
  if (dest === undefined || failAt === "pack-missing") {
    return;
  }
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const name = command.includes("@gusto/create-baerly-storage")
    ? `gusto-create-baerly-storage-${version}.tgz`
    : `gusto-baerly-storage-${version}.tgz`;
  writeFileSync(join(dest, name), "");
};

childProcess.execSync = (command) => {
  process.stderr.write(`STUB_COMMAND:${command}\n`);

  const failed =
    (failAt === "artifacts" && command === "pnpm run verify:artifacts") ||
    (failAt === "packaging" && command === "pnpm run verify:package") ||
    (failAt?.startsWith("publish:") && command.includes(" publish") && matchesPkg(command));

  if (failed) {
    const error = new Error(`stubbed failure: ${command}`);
    error.stderr = Buffer.from(`stubbed failure: ${command}`);
    throw error;
  }

  if (command.startsWith("npm publish ")) {
    return Buffer.alloc(0);
  }

  if (command.startsWith("pnpm ")) {
    if (command.includes(" pack ")) {
      fakePack(command);
    }
    return Buffer.alloc(0);
  }

  throw new Error(`unexpected child command in publish test: ${command}`);
};

// `publish:<pkg>` fails the publish command for that package, whether the
// command names it by `--filter` (dry run) or by tarball file (publish).
function matchesPkg(command) {
  const pkg = failAt.slice("publish:".length);
  const isScaffolder =
    command.includes("@gusto/create-baerly-storage") ||
    command.includes("gusto-create-baerly-storage-");
  return pkg === "@gusto/create-baerly-storage" ? isScaffolder : !isScaffolder;
}
syncBuiltinESMExports();
