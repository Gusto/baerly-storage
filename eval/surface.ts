import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url); // eval/ -> repo root
const DIST = new URL("dist/", ROOT);

function distPath(rel: string): string {
  return fileURLToPath(new URL(rel, DIST));
}

export type SurfaceKind = "api-md+dts" | "api-md+dts+agents-md";

export interface Surface {
  readonly text: string;
  readonly sha256: string;
  readonly kind: SurfaceKind;
}

export function loadSurface(opts: { withAgentsMd: boolean }): Surface {
  const distDir = fileURLToPath(DIST);
  if (!existsSync(distPath("API.md"))) {
    throw new Error("eval: dist/API.md not found — run `pnpm build` before `pnpm eval`.");
  }
  const parts: string[] = [];
  parts.push("===== dist/API.md =====\n" + readFileSync(distPath("API.md"), "utf8"));
  // Whole .d.ts chain, sorted for a stable hash.
  const dts = readdirSync(distDir)
    .filter((f) => f.endsWith(".d.ts"))
    .toSorted();
  for (const f of dts) {
    parts.push(`===== dist/${f} =====\n` + readFileSync(distPath(f), "utf8"));
  }
  let kind = "api-md+dts";
  if (opts.withAgentsMd) {
    const agents = fileURLToPath(new URL("examples/minimal-node/AGENTS.md", ROOT));
    parts.push("===== examples/minimal-node/AGENTS.md =====\n" + readFileSync(agents, "utf8"));
    kind = "api-md+dts+agents-md";
  }
  const text = parts.join("\n\n");
  const sha256 = createHash("sha256").update(text).digest("hex");
  return { text, sha256, kind };
}
