// Minimal todo-app worker fixture for the check-acceptance harness.
// References the table-API surface, a non-dummy verifier, and the four
// CRUD verbs on the `todos` table.

import { sharedSecret } from "@baerly/server/auth";

declare const db: any;

export const verifier = sharedSecret({ secret: "test" });

export async function listTodos() {
  return db.table("todos").where({ status: "open" }).all();
}

export async function createTodo(title: string) {
  return db.table("todos").insert({ title, status: "open" });
}

export async function updateTodo(id: string, title: string) {
  return db.table("todos").update(id, { title });
}

export async function deleteTodo(id: string) {
  return db.table("todos").delete(id);
}
