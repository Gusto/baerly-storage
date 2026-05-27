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
    expect(result.changes).toContain("merged vars: APP, TENANT");
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
    expect(result.changes).toContain("merged vars: TENANT");
    expect(result.changes.join("\n")).not.toContain("APP");
  });
});

describe("patchWranglerJsonc — indent preservation", () => {
  // The stock `pnpm create cloudflare --type=hello-world` template
  // emits tab-indented wrangler.jsonc. Hard-coding 2-space here
  // produced a mixed-indent diff after the bolt-on patch — parses
  // fine, looks ugly. detectIndent() should match the source.
  const tabWrangler = `{
\t"$schema": "node_modules/wrangler/config-schema.json",
\t"name": "noisy-cell-04d4",
\t"main": "src/index.ts",
\t"compatibility_date": "2026-05-24",
\t"observability": { "enabled": true }
}
`;

  test("tab-indented source stays tab-indented after patch", () => {
    const result = patchWranglerJsonc(tabWrangler, BINDING, VARS);
    // No 2-space leading indent should appear on any non-blank line —
    // every line either keeps its tab, has no indent, or sits inside
    // an inline-formatted block. (We don't assert "all tabs" because
    // jsonc-parser can emit single-space gaps inside compact objects.)
    const lines = result.text.split("\n");
    for (const line of lines) {
      if (line.startsWith("  ") && !line.startsWith("   ")) {
        throw new Error(`unexpected 2-space leading indent: ${JSON.stringify(line)}`);
      }
    }
    expect(result.text).toContain(`\t"r2_buckets"`);
    expect(result.text).toContain(`\t"vars"`);
  });

  test("4-space-indented source stays 4-space-indented after patch", () => {
    const fourSpace = `{
    "name": "x",
    "main": "src/index.ts"
}
`;
    const result = patchWranglerJsonc(fourSpace, BINDING, VARS);
    expect(result.text).toContain(`    "r2_buckets"`);
    expect(result.text).toContain(`    "vars"`);
    // Sanity: appended block uses 4 spaces for nested keys, not 2.
    expect(result.text).toContain(`        "binding"`);
  });

  test("empty object falls back to 2-space (default)", () => {
    const result = patchWranglerJsonc("{}\n", BINDING, {});
    expect(result.text).toContain(`  "r2_buckets"`);
  });

  test("tab-indented patch remains idempotent", () => {
    const first = patchWranglerJsonc(tabWrangler, BINDING, VARS);
    const second = patchWranglerJsonc(first.text, BINDING, VARS);
    expect(second.text).toBe(first.text);
    expect(second.changes).toEqual([]);
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
