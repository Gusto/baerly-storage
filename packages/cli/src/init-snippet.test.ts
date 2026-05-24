import { describe, test, expect } from "vitest";
import { renderWorkerEntrySnippet, computeConfigImportPath } from "./init-snippet.ts";

describe("computeConfigImportPath", () => {
  test("src/index.ts → ../baerly.config.ts", () => {
    expect(computeConfigImportPath("src/index.ts")).toBe("../baerly.config.ts");
  });

  test("src/server/index.ts → ../../baerly.config.ts", () => {
    expect(computeConfigImportPath("src/server/index.ts")).toBe("../../baerly.config.ts");
  });

  test("worker.ts (root) → ./baerly.config.ts", () => {
    expect(computeConfigImportPath("worker.ts")).toBe("./baerly.config.ts");
  });

  test("./src/index.ts (leading dot) normalised", () => {
    expect(computeConfigImportPath("./src/index.ts")).toBe("../baerly.config.ts");
  });
});

describe("renderWorkerEntrySnippet", () => {
  test("renders a snippet with the computed import path", () => {
    const snippet = renderWorkerEntrySnippet({
      tenant: "default",
      wranglerMain: "src/index.ts",
    });
    expect(snippet).toContain(`from "baerly-storage/cloudflare"`);
    expect(snippet).toContain(`from "baerly-storage/auth"`);
    expect(snippet).toContain(`import config from "../baerly.config.ts"`);
    expect(snippet).toContain(`tenantPrefix: env.TENANT`);
    expect(snippet).toContain(`export default baerlyWorker<AppEnv>`);
  });

  test("nested worker entry adjusts the import path", () => {
    const snippet = renderWorkerEntrySnippet({
      tenant: "default",
      wranglerMain: "src/server/index.ts",
    });
    expect(snippet).toContain(`import config from "../../baerly.config.ts"`);
  });
});
