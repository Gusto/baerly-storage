Define a `baerly.config.ts`-style configuration for a `tasks` collection that requires a `title` field of type `string`. Use `defineConfig` from `@gusto/baerly-storage/config` with a Zod schema. Export it as a named export `config`.

Then export a `main(db)` function that inserts one valid row `{ title: "x" }` into the `tasks` collection and returns the stored row as read back from the collection.

The harness will also verify that inserting an invalid row (missing `title`) rejects with an error.

Export `export const config = defineConfig({...})` AND `export async function main(db)` — the harness picks up both. Do not create storage; a `Db` is already constructed from your `config`. Use only the documented API.
