import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectPm, installCommand, runCommand } from "./pm-detect.ts";

describe("detectPm", () => {
  // detectPm reads `process.env.npm_config_user_agent` when its arg
  // defaults. Stash + clear around each case so the "undefined →
  // npm" branch is exercised regardless of which PM ran the suite.
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["npm_config_user_agent"];
    delete process.env["npm_config_user_agent"];
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env["npm_config_user_agent"];
    } else {
      process.env["npm_config_user_agent"] = saved;
    }
  });

  test("defaults to npm when the user-agent is undefined", () => {
    expect(detectPm(undefined)).toBe("npm");
  });

  test("returns npm for npm/<version>", () => {
    expect(detectPm("npm/10.5.0 node/v24.0.0 darwin x64")).toBe("npm");
  });

  test("returns pnpm for pnpm/<version>", () => {
    expect(detectPm("pnpm/10.31.0 node/v24 darwin x64")).toBe("pnpm");
  });

  test("returns yarn for yarn/<version>", () => {
    expect(detectPm("yarn/4.4.0 node/v24 darwin x64")).toBe("yarn");
  });

  test("falls back to npm for an unknown leading PM", () => {
    expect(detectPm("bun/1.0.0 node/v24 darwin x64")).toBe("npm");
  });

  test("falls back to npm for a malformed user-agent (no slash)", () => {
    expect(detectPm("garbage")).toBe("npm");
  });
});

describe("installCommand", () => {
  test("returns the install verb for each pm", () => {
    expect(installCommand("npm")).toBe("npm install");
    expect(installCommand("pnpm")).toBe("pnpm install");
    expect(installCommand("yarn")).toBe("yarn install");
  });
});

describe("runCommand", () => {
  test("prefixes scripts with `npm run` for npm", () => {
    expect(runCommand("npm", "dev")).toBe("npm run dev");
  });

  test("prefixes scripts with `pnpm` for pnpm (no `run` keyword)", () => {
    expect(runCommand("pnpm", "dev")).toBe("pnpm dev");
  });

  test("prefixes scripts with `yarn` for yarn (no `run` keyword)", () => {
    expect(runCommand("yarn", "dev")).toBe("yarn dev");
  });
});
