import { describe, test, expect } from "vitest";
import {
  patchWranglerJsonc,
  readWranglerName,
  readWranglerMain,
  type R2BindingSpec,
  type VarsSpec,
} from "./wrangler-patch.ts";

const STOCK_WRANGLER_CREATE = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "noisy-cell-04d4",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-24",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": "./public" },
  "observability": { "enabled": true },
  "upload_source_maps": true
}
`;

const BINDING: R2BindingSpec = { binding: "BUCKET", bucket_name: "noisy-cell-04d4" };
const VARS: VarsSpec = {
  APP: "noisy-cell-04d4",
  TENANT: "default",
  LOG_LEVEL: "info",
  LOG_SAMPLE: "0.1",
};

describe("readWranglerName / readWranglerMain", () => {
  test("reads name and main from a stock wrangler.jsonc", () => {
    expect(readWranglerName(STOCK_WRANGLER_CREATE)).toBe("noisy-cell-04d4");
    expect(readWranglerMain(STOCK_WRANGLER_CREATE)).toBe("src/index.ts");
  });

  test("returns undefined when name/main absent", () => {
    expect(readWranglerName("{}")).toBeUndefined();
    expect(readWranglerMain("{}")).toBeUndefined();
  });

  test("returns undefined on malformed JSONC", () => {
    expect(readWranglerName("{ not json")).toBeUndefined();
    expect(readWranglerMain("{ not json")).toBeUndefined();
  });
});

describe("patchWranglerJsonc — first patch", () => {
  test("adds r2_buckets + vars to a stock wrangler.jsonc", () => {
    const result = patchWranglerJsonc(STOCK_WRANGLER_CREATE, BINDING, VARS);
    expect(result.text).toContain(`"r2_buckets"`);
    expect(result.text).toContain(`"binding": "BUCKET"`);
    expect(result.text).toContain(`"bucket_name": "noisy-cell-04d4"`);
    expect(result.text).toContain(`"APP": "noisy-cell-04d4"`);
    expect(result.text).toContain(`"TENANT": "default"`);
    expect(result.changes).toContain("added r2 binding BUCKET → noisy-cell-04d4");
    expect(result.changes).toContain("merged vars: APP, TENANT, LOG_LEVEL, LOG_SAMPLE");
  });

  test("preserves user comments", () => {
    const source = `{
  // user comment that must survive
  "name": "x",
  "main": "src/index.ts"
}
`;
    const result = patchWranglerJsonc(source, BINDING, VARS);
    expect(result.text).toContain("// user comment that must survive");
  });

  test("preserves trailing commas", () => {
    const source = `{
  "name": "x",
  "main": "src/index.ts",
  "compatibility_flags": ["nodejs_compat",],
}
`;
    const result = patchWranglerJsonc(source, BINDING, VARS);
    expect(result.text).toContain(`"nodejs_compat",`);
  });
});

describe("patchWranglerJsonc — idempotency", () => {
  test("re-running patch produces no further changes", () => {
    const first = patchWranglerJsonc(STOCK_WRANGLER_CREATE, BINDING, VARS);
    const second = patchWranglerJsonc(first.text, BINDING, VARS);
    expect(second.text).toBe(first.text);
    expect(second.changes).toEqual([]);
  });

  test("existing binding with same name → no-op", () => {
    const withBinding = `{
  "name": "x",
  "main": "src/index.ts",
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "existing-bucket" }]
}
`;
    const result = patchWranglerJsonc(withBinding, BINDING, {});
    expect(result.text).toContain(`"bucket_name": "existing-bucket"`);
    expect(result.text).not.toContain("noisy-cell-04d4");
    expect(result.changes).toEqual([]);
  });

  test("existing binding with different name → appends", () => {
    const withOther = `{
  "name": "x",
  "main": "src/index.ts",
  "r2_buckets": [{ "binding": "OTHER", "bucket_name": "other-bucket" }]
}
`;
    const result = patchWranglerJsonc(withOther, BINDING, {});
    expect(result.text).toContain(`"binding": "OTHER"`);
    expect(result.text).toContain(`"binding": "BUCKET"`);
    expect(result.changes).toContain("added r2 binding BUCKET → noisy-cell-04d4");
  });

  test("existing vars with overlapping keys → user wins, missing keys added", () => {
    const withVars = `{
  "name": "x",
  "main": "src/index.ts",
  "vars": { "APP": "user-set-value", "CUSTOM": "user-only" }
}
`;
    const result = patchWranglerJsonc(withVars, BINDING, VARS);
    expect(result.text).toContain(`"APP": "user-set-value"`);
    expect(result.text).toContain(`"CUSTOM": "user-only"`);
    expect(result.text).toContain(`"TENANT": "default"`);
    expect(result.changes).toContain("merged vars: TENANT, LOG_LEVEL, LOG_SAMPLE");
    expect(result.changes.join("\n")).not.toContain("APP");
  });
});

describe("patchWranglerJsonc — error cases", () => {
  test("malformed JSONC throws BaerlyError InvalidConfig", () => {
    expect(() => patchWranglerJsonc("{ this is not json", BINDING, VARS)).toThrow(
      /wrangler\.jsonc parse error/,
    );
  });

  test("malformed r2_buckets entry throws InvalidConfig", () => {
    const bad = `{ "name": "x", "main": "src/index.ts", "r2_buckets": [42] }`;
    expect(() => patchWranglerJsonc(bad, BINDING, {})).toThrow(/r2_buckets/);
  });

  test("non-object vars throws InvalidConfig", () => {
    const bad = `{ "name": "x", "main": "src/index.ts", "vars": "not an object" }`;
    expect(() => patchWranglerJsonc(bad, BINDING, {})).toThrow(/vars/);
  });
});
