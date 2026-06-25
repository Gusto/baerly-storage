import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ERROR_CODES, MemoryStorage, PREDICATE_OPS } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { buildSpecIR } from "@baerly/server/_internal/spec-gen";

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = resolve(here, "../packages/server/spec/baerly.spec.json");
const schemaPath = resolve(here, "../packages/protocol/src/spec/ir-schema.json");

const fail = (msg: string): never => {
  console.error(`spec-drift: ${msg}`);
  console.error("To fix: run `pnpm gen:spec` and commit packages/server/spec/baerly.spec.json");
  process.exit(1);
};

let checkedIn: string;
try {
  checkedIn = readFileSync(artifactPath, "utf8");
} catch (error) {
  fail(`missing artifact at ${artifactPath}: ${(error as Error).message}`);
  throw new Error("unreachable", { cause: error }); // tsgo does not narrow definite-assignment through fail()'s `never`
}

let parsed: {
  errorCodes: Array<{ code: string }>;
  operators: Array<{ name: string }>;
  httpRoutes: Array<{ method: string; path: string }>;
};
try {
  parsed = JSON.parse(checkedIn);
} catch (error) {
  fail(`checked-in baerly.spec.json is not valid JSON: ${(error as Error).message}`);
  throw new Error("unreachable", { cause: error }); // tsgo does not narrow definite-assignment through fail()'s `never`
}

let schema: object;
try {
  schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
} catch (error) {
  fail(`missing or invalid IR schema at ${schemaPath}: ${(error as Error).message}`);
  throw new Error("unreachable", { cause: error }); // tsgo does not narrow definite-assignment through fail()'s `never`
}

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);
if (!validate(parsed)) {
  fail(
    `checked-in baerly.spec.json does not satisfy ir-schema.json: ${JSON.stringify(validate.errors)}`,
  );
}

// DATA compare (formatting-agnostic). buildSpecIR()'s key order is the
// order the artifact was generated in, and oxfmt does not reorder JSON
// keys, so a compact re-stringify of each is byte-equal iff the contract
// matches. (If a future oxfmt DID reorder keys, format:check would have
// already rewritten the artifact, so the orders still agree here.)
if (JSON.stringify(buildSpecIR()) !== JSON.stringify(parsed)) {
  fail("checked-in baerly.spec.json is stale vs the generator");
}

// Enumeration-completeness backstop (independent of the data compare).
const irCodes = new Set(parsed.errorCodes.map((e) => e.code));
for (const code of ERROR_CODES) {
  if (!irCodes.has(code)) {
    fail(`error code '${code}' has no IR entry`);
  }
}
const irOps = new Set(parsed.operators.map((o) => o.name));
for (const op of PREDICATE_OPS) {
  if (!irOps.has(op)) {
    fail(`operator '${op}' has no IR entry`);
  }
}

// Route-completeness backstop: the kernel router is the source of truth
// for the /v1 CRUD surface (this is the section that silently drifted —
// the by-id routes were missing from the IR while the router served
// them). The two anonymous routes (healthz, spec) are served upstream
// of the router by both adapters, so they're added explicitly. Assert
// an EXACT match so the IR can neither omit a served route nor advertise
// one the kernel doesn't serve.
const servedRoutes = new Set<string>(["GET /v1/healthz", "GET /v1/spec"]);
const probeDb = Db.create({ storage: new MemoryStorage(), app: "drift", tenant: "drift" });
for (const r of createRouter({ db: probeDb }).routes) {
  if (r.path.startsWith("/v1/")) {
    servedRoutes.add(`${r.method} ${r.path}`);
  }
}
const irRoutes = new Set(parsed.httpRoutes.map((r) => `${r.method} ${r.path}`));
for (const route of servedRoutes) {
  if (!irRoutes.has(route)) {
    fail(`route '${route}' is served by the kernel but has no IR httpRoutes entry`);
  }
}
for (const route of irRoutes) {
  if (!servedRoutes.has(route)) {
    fail(`IR httpRoutes lists '${route}' which the kernel does not serve`);
  }
}

console.log(
  `spec-drift: ok (${parsed.errorCodes.length} codes, ${parsed.operators.length} operators, ${parsed.httpRoutes.length} routes)`,
);
