import { describe, expect, test } from "vitest";

import { findViolations } from "../../scripts/lint-package-layers.mjs";

describe("lint-package-layers", () => {
  test("protocol importing server is a violation", () => {
    const violations = findViolations([
      {
        path: "packages/protocol/src/foo.ts",
        source: 'import { Db } from "@baerly/server";',
        ownerPkg: "protocol",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ownerPkg: "protocol", importedPkg: "server" });
  });

  test("subpath imports are still classified by package name", () => {
    // adapter-node imports @baerly/server/http — allowed (server is in the allow-list).
    // The regex must capture the package name even when a subpath follows.
    const ok = findViolations([
      {
        path: "packages/adapter-node/src/app.ts",
        source: 'import { MAX_BODY_BYTES } from "@baerly/server/http";',
        ownerPkg: "adapter-node",
      },
    ]);
    expect(ok).toEqual([]);

    // protocol importing @baerly/server/_internal/testing — forbidden, subpath ignored.
    const bad = findViolations([
      {
        path: "packages/protocol/src/foo.ts",
        source: 'import { Writer } from "@baerly/server/_internal/testing";',
        ownerPkg: "protocol",
      },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.importedPkg).toBe("server");
  });

  test("protocol importing a node: builtin is a violation", () => {
    const violations = findViolations([
      {
        path: "packages/protocol/src/foo.ts",
        source: 'import { createReadStream } from "node:fs";',
        ownerPkg: "protocol",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ownerPkg: "protocol", importedPkg: "node:fs" });
  });

  test("server importing node:async_hooks is allowed (Workerd nodejs_compat)", () => {
    const violations = findViolations([
      {
        path: "packages/server/src/observability/context.ts",
        source: 'import { AsyncLocalStorage } from "node:async_hooks";',
        ownerPkg: "server",
      },
    ]);
    expect(violations).toEqual([]);
  });

  test("server importing node:fs is a violation", () => {
    const violations = findViolations([
      {
        path: "packages/server/src/foo.ts",
        source: 'import x from "node:fs";',
        ownerPkg: "server",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ownerPkg: "server", importedPkg: "node:fs" });
  });

  test("dynamic import of a forbidden @baerly/* is a violation", () => {
    const violations = findViolations([
      {
        path: "packages/server/src/foo.ts",
        source: 'const m = await import("@baerly/adapter-node");',
        ownerPkg: "server",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ownerPkg: "server", importedPkg: "adapter-node" });
  });

  test("relative cross-package import is classified by target package", () => {
    const violations = findViolations([
      {
        path: "packages/adapter-node/src/foo.ts",
        source: 'import { y } from "../../adapter-cloudflare/src/index.ts";',
        ownerPkg: "adapter-node",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ownerPkg: "adapter-node",
      importedPkg: "adapter-cloudflare",
    });
  });

  test("same-package single climb is not a cross-package violation", () => {
    // `../writer.ts` is a sibling within the same package, not a sibling-package
    // edge. RELATIVE_CROSS_RE requires `<name>/` after the climb, so a bare
    // `../foo.ts` never matches — false-positive defense.
    const violations = findViolations([
      {
        path: "packages/server/src/foo.ts",
        source: 'import { x } from "../writer.ts";',
        ownerPkg: "server",
      },
    ]);
    expect(violations).toEqual([]);
  });

  test("relative climb-out to a non-package sibling dir is not a violation", () => {
    // `../../tests/fixtures/foo.ts` captures `tests`, which is not a RULES key,
    // so the membership guard filters it before it can produce a false positive.
    const violations = findViolations([
      {
        path: "packages/adapter-node/src/foo.ts",
        source: 'import { x } from "../../tests/fixtures/foo.ts";',
        ownerPkg: "adapter-node",
      },
    ]);
    expect(violations).toEqual([]);
  });
});
