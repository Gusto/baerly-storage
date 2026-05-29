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
});
