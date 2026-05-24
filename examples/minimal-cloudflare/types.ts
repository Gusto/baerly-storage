/**
 * Types shared between the Worker (`src/server/`) and the SPA
 * (`src/web/`). Both `tsconfig.worker.json` and `tsconfig.app.json`
 * include this file, so a type defined here is visible on both
 * sides without a project-references workaround.
 */
import type { DocumentData } from "baerly-storage/config";

/**
 * One row in the `notes` collection. The minimal scaffold ships a
 * single collection so `src/web/main.ts` round-trips through the DB
 * on first load. Extending the schema is one new field here +
 * (optionally) a Standard Schema validator in `baerly.config.ts`.
 *
 * **Replacing the demo?** `src/web/main.ts` imports `Note` from this
 * file. Rename the interface or swap it for your own row type
 * (anything that extends `DocumentData`) and update the consumer's
 * import — the kernel doesn't care about the name, only the shape.
 */
export interface Note extends DocumentData {
  _id: string;
  body: string;
}
