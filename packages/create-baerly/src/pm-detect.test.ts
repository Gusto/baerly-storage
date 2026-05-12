import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPm, installCommand, runCommand } from "./pm-detect";

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
    if (saved === undefined) delete process.env["npm_config_user_agent"];
    else process.env["npm_config_user_agent"] = saved;
  });

  it("defaults to npm when the user-agent is undefined", () => {
    expect(detectPm(undefined)).toBe("npm");
  });

  it("returns npm for npm/<version>", () => {
    expect(detectPm("npm/10.5.0 node/v24.0.0 darwin x64")).toBe("npm");
  });

  it("returns pnpm for pnpm/<version>", () => {
    expect(detectPm("pnpm/10.31.0 node/v24 darwin x64")).toBe("pnpm");
  });

  it("returns yarn for yarn/<version>", () => {
    expect(detectPm("yarn/4.4.0 node/v24 darwin x64")).toBe("yarn");
  });

  it("falls back to npm for an unknown leading PM", () => {
    expect(detectPm("bun/1.0.0 node/v24 darwin x64")).toBe("npm");
  });

  it("falls back to npm for a malformed user-agent (no slash)", () => {
    expect(detectPm("garbage")).toBe("npm");
  });
});

describe("installCommand", () => {
  it("returns the install verb for each pm", () => {
    expect(installCommand("npm")).toBe("npm install");
    expect(installCommand("pnpm")).toBe("pnpm install");
    expect(installCommand("yarn")).toBe("yarn install");
  });
});

describe("runCommand", () => {
  it("prefixes scripts with `npm run` for npm", () => {
    expect(runCommand("npm", "dev")).toBe("npm run dev");
  });

  it("prefixes scripts with `pnpm` for pnpm (no `run` keyword)", () => {
    expect(runCommand("pnpm", "dev")).toBe("pnpm dev");
  });

  it("prefixes scripts with `yarn` for yarn (no `run` keyword)", () => {
    expect(runCommand("yarn", "dev")).toBe("yarn dev");
  });
});
