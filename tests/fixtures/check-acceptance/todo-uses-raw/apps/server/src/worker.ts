// Fixture: reaches into db._raw. The no_raw_access bullet must flip false.
import { sharedSecret } from "@baerly/server/auth";

declare const db: any;

export const verifier = sharedSecret({ secret: "test" });

export async function createTodoRaw(payload: unknown) {
  // Anti-pattern: bypass the table API and stuff bytes into the bucket
  // directly. This is exactly what the no_raw_access bullet exists to
  // catch.
  return db._raw.put("todos/raw", payload);
}
