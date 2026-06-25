import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";

// Compile the canonical IR JSON Schema once. Shared by the spec tests
// (buildSpecIR + buildSpecResponse) so a schema-loader change — path move,
// JSON-Schema draft bump — is a single edit here.
const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(here, "../../packages/protocol/src/spec/ir-schema.json"), "utf8"),
) as object;
const validate = new Ajv2020({ allErrors: true }).compile(schema);

/** Assert `body` validates against `protocol/src/spec/ir-schema.json`. */
export function expectValidAgainstIrSchema(body: unknown): void {
  const ok = validate(body);
  if (!ok) {
    throw new Error(`failed ir-schema.json: ${JSON.stringify(validate.errors, null, 2)}`);
  }
  expect(ok).toBe(true);
}
