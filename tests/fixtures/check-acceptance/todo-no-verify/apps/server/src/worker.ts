// Fixture: verify fails. Stub the rest so the other bullets aren't
// the proximate failure under inspection.
import { sharedSecret } from "@baerly/server/auth";

declare const db: any;

export const verifier = sharedSecret({ secret: "test" });

export async function createTodo() {
  return db.table("todos").insert({});
}
