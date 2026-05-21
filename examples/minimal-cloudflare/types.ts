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
 */
export interface Note extends DocumentData {
  _id: string;
  body: string;
  created_at: string;
}
