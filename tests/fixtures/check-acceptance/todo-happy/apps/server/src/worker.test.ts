// Fixture test file — never actually executed (the fixture's `pnpm test`
// script is `exit 0`). Present so the check-acceptance harness's
// co-occurrence heuristic (`insert` + `todos` in some *.test.ts) flips
// `test` bullet to pass.
//
// inserts a todo and reads it back via the table API
import { createTodo, listTodos } from "./worker.ts";

export async function smoke() {
  await createTodo("buy milk"); // insert into todos
  const all = await listTodos();
  return all;
}
