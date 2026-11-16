// Node ESM resolver hook: map @gusto/baerly-storage[/sub] to the built dist/*.js,
// so the eval's run-solution subprocess and the agent's generated solution.ts
// resolve the PUBLISHED runtime (what a real installed user gets), not the
// workspace source. Chained after bench/register-hooks.mjs (which adds .ts
// resolution for relative imports). dist/ must be built (`pnpm build`).
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const PKG = "@gusto/baerly-storage";
const ROOT = new URL("../", import.meta.url); // eval/ -> repo root
// publishConfig.exports subpath -> dist entry (keep in sync with root package.json)
const SUBPATH_TO_DIST = {
  ".": "index",
  "./auth": "auth",
  "./http": "http",
  "./cloudflare": "cloudflare",
  "./node": "node",
  "./s3": "s3",
  "./gcs": "gcs",
  "./maintenance": "maintenance",
  "./observability": "observability",
  "./config": "app-config",
  "./client": "client",
  "./client/react": "client-react",
  "./dev": "dev",
  "./dev/vite": "dev-vite",
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === PKG || specifier.startsWith(`${PKG}/`)) {
    const sub = specifier === PKG ? "." : `./${specifier.slice(PKG.length + 1)}`;
    const entry = SUBPATH_TO_DIST[sub];
    if (entry) {
      const url = new URL(`dist/${entry}.js`, ROOT);
      if (existsSync(fileURLToPath(url))) {
        return { url: url.href, format: "module", shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
