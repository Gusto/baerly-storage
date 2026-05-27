/**
 * Worker entry for react-cloudflare. `baerlyWorker(opts)` reads
 * `opts.config.auth` to choose its verifier — the scaffold ships
 * `auth: "none"`, so every request resolves to `config.tenant`.
 * The schema declared in `baerly.config.ts:collections.notes.schema`
 * runs server-side on every write. See AGENTS.md "Going to
 * production" for the recipe to flip `auth` or wire a custom verifier.
 */
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";

export default baerlyWorker(() => ({ config }));
