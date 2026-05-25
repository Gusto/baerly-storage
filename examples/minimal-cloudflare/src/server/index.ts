/**
 * Worker entry for minimal-cloudflare. `baerlyWorker(opts)` reads
 * `opts.config.auth` to choose its verifier — the scaffold ships
 * `auth: "none"`, so every request resolves to `config.tenant`
 * with no header check. See AGENTS.md "Going to production" for
 * the recipe to flip `auth` or wire a custom verifier.
 */
import { baerlyWorker } from "baerly-storage/cloudflare";
import config from "../../baerly.config.ts";

export default baerlyWorker(() => ({ config }));
