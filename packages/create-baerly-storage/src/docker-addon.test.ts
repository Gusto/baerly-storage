import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard on the Docker add-on Dockerfile. A real `docker build`
 * is out of scope for the no-infra gate, so we assert against the
 * template source instead.
 *
 * The Node server entrypoint (`src/server/index.ts` in both
 * `minimal-node` and `react-node`) does
 * `import config from "../../baerly.config.ts"` — the config lives at
 * the project ROOT, two levels up from the entrypoint. The runtime
 * stage selectively COPYs only a handful of paths, so any project-root
 * file the entrypoint needs at runtime MUST be copied explicitly, or
 * the container crashes on boot with an unresolved import.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dockerfilePath = resolve(here, "..", "templates", "addons", "docker", "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

/** Everything from the runtime `FROM ... AS runtime` stage onward. */
const runtimeStage = (() => {
  const idx = dockerfile.indexOf("AS runtime");
  expect(idx).toBeGreaterThan(-1);
  return dockerfile.slice(idx);
})();

describe("docker add-on Dockerfile", () => {
  test("runtime stage copies baerly.config.ts so the server entrypoint's `../../baerly.config.ts` import resolves", () => {
    expect(runtimeStage).toMatch(/COPY --from=build [^\n]*baerly\.config\.ts/);
  });
});
