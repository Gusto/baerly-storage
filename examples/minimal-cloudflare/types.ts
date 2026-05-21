/**
 * Types shared between the Worker (`src/server/`) and the SPA
 * (`src/web/`). Both `tsconfig.worker.json` and `tsconfig.app.json`
 * include this file, so a type defined here is visible on both
 * sides without a project-references workaround.
 *
 * Empty by default — extend it when a row type or interface
 * crosses the server↔web boundary. Example:
 *
 * ```ts
 * import type { DocumentData } from "baerly-storage";
 * export interface Bookmark extends DocumentData {
 *   _id: string;
 *   url: string;
 *   title: string;
 * }
 * ```
 */

