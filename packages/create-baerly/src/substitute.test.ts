import { describe, expect, test } from "vitest";
import {
  type ScaffoldManifest,
  type SubstituteContext,
  substitutePackageJson,
  substituteText,
} from "./substitute.ts";

const mkCtx = (manifest: ScaffoldManifest, vars: Record<string, string>): SubstituteContext => ({
  manifest,
  vars,
  cliVersion: "1.2.3",
});

describe("substituteText", () => {
  test("rewrites a single sentinel", () => {
    const ctx = mkCtx(
      {
        renames: [{ from: "minimal-cloudflare", fromKey: "appName" }],
        excludePaths: [],
        dropDevDeps: [],
      },
      { appName: "my-app" },
    );
    expect(substituteText("name: minimal-cloudflare", ctx)).toBe("name: my-app");
  });

  test("applies longer sentinels first so prefixes don't corrupt", () => {
    const ctx = mkCtx(
      {
        renames: [
          { from: "minimal-cloudflare", fromKey: "appName" },
          { from: "minimal-cloudflare-server", fromKey: "serverName" },
        ],
        excludePaths: [],
        dropDevDeps: [],
      },
      { appName: "my-app", serverName: "my-server" },
    );
    expect(substituteText("[minimal-cloudflare-server]", ctx)).toBe("[my-server]");
  });

  test("leaves unknown fromKeys untouched", () => {
    const ctx = mkCtx(
      { renames: [{ from: "minimal-demo", fromKey: "tenant" }], excludePaths: [], dropDevDeps: [] },
      {},
    );
    expect(substituteText("tenant=minimal-demo", ctx)).toBe("tenant=minimal-demo");
  });
});

describe("substitutePackageJson", () => {
  test("pins baerly-storage workspace dep to the cli version", () => {
    const ctx = mkCtx({ renames: [], excludePaths: [], dropDevDeps: [] }, {});
    const text = JSON.stringify(
      { name: "x", dependencies: { "baerly-storage": "workspace:*", other: "1.0.0" } },
      null,
      2,
    );
    const out = JSON.parse(substitutePackageJson(text, ctx)) as {
      dependencies: Record<string, string>;
    };
    expect(out.dependencies["baerly-storage"]).toBe("^1.2.3");
    expect(out.dependencies["other"]).toBe("1.0.0");
  });

  test("does not pin unrelated workspace:* dep names", () => {
    const ctx = mkCtx({ renames: [], excludePaths: [], dropDevDeps: [] }, {});
    const text = JSON.stringify(
      { name: "x", dependencies: { "@baerly/protocol": "workspace:*", other: "workspace:*" } },
      null,
      2,
    );
    const out = JSON.parse(substitutePackageJson(text, ctx)) as {
      dependencies: Record<string, string>;
    };
    expect(out.dependencies["@baerly/protocol"]).toBe("workspace:*");
    expect(out.dependencies["other"]).toBe("workspace:*");
  });

  test("pins the literal `create-baerly` workspace dep to the cli version", () => {
    // The emitted `baerly.config.ts` imports `create-baerly/config`,
    // so the scaffolder keeps `create-baerly` as a devDep and pins
    // it alongside `baerly-storage`.
    const ctx = mkCtx({ renames: [], excludePaths: [], dropDevDeps: [] }, {});
    const text = JSON.stringify(
      { name: "x", devDependencies: { "create-baerly": "workspace:*", typescript: "^5" } },
      null,
      2,
    );
    const out = JSON.parse(substitutePackageJson(text, ctx)) as {
      devDependencies: Record<string, string>;
    };
    expect(out.devDependencies["create-baerly"]).toBe("^1.2.3");
    expect(out.devDependencies["typescript"]).toBe("^5");
  });

  test("drops listed devDependencies", () => {
    const ctx = mkCtx({ renames: [], excludePaths: [], dropDevDeps: ["create-baerly"] }, {});
    const text = JSON.stringify(
      { name: "x", devDependencies: { "create-baerly": "workspace:*", typescript: "^5" } },
      null,
      2,
    );
    const out = JSON.parse(substitutePackageJson(text, ctx)) as {
      devDependencies?: Record<string, string>;
    };
    expect(out.devDependencies).toEqual({ typescript: "^5" });
  });

  test("removes the devDependencies block entirely when it becomes empty", () => {
    const ctx = mkCtx({ renames: [], excludePaths: [], dropDevDeps: ["only"] }, {});
    const text = JSON.stringify({ name: "x", devDependencies: { only: "workspace:*" } }, null, 2);
    const out = JSON.parse(substitutePackageJson(text, ctx)) as {
      devDependencies?: Record<string, string>;
    };
    expect(out.devDependencies).toBeUndefined();
  });
});
