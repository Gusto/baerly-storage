/**
 * Unit tests for `prompts.ts`. The clack APIs are mocked via
 * `vi.mock("@clack/prompts", ...)` so the tests don't depend on a
 * real TTY. The mock factory exposes per-prompt fixture hooks so
 * each `it` can swap in the value (or `isCancel` sentinel) it needs.
 */
import { describe, expect, test, vi } from "vitest";
import type { ScaffoldWizardOutput } from "./prompts.ts";

// `isCancel` returns true when the underlying prompt return value is
// this sentinel symbol. The clack source uses a distinct cancel
// symbol; we replicate that contract in the mock.
const CANCEL_SENTINEL: unique symbol = Symbol.for("baerly.test.cancel");

// Per-test fixture state mutated through the exported helpers below.
// Resetting between tests is the caller's job (`vi.resetModules()`).
interface ClackFixture {
  textValue: unknown;
  selectValue: unknown;
  confirmValue: unknown;
  textCalls: unknown[];
  selectCalls: unknown[];
  confirmCalls: unknown[];
  introCalls: unknown[];
  cancelCalls: unknown[];
}

const fixture: ClackFixture = {
  textValue: undefined,
  selectValue: undefined,
  confirmValue: undefined,
  textCalls: [],
  selectCalls: [],
  confirmCalls: [],
  introCalls: [],
  cancelCalls: [],
};

const resetFixture = (): void => {
  fixture.textValue = undefined;
  fixture.selectValue = undefined;
  fixture.confirmValue = undefined;
  fixture.textCalls = [];
  fixture.selectCalls = [];
  fixture.confirmCalls = [];
  fixture.introCalls = [];
  fixture.cancelCalls = [];
};

vi.mock("@clack/prompts", () => ({
  intro: (msg: string) => {
    fixture.introCalls.push(msg);
  },
  outro: (_msg: string) => {
    /* not exercised by these tests */
  },
  note: (_msg: string) => {
    /* not exercised by these tests */
  },
  text: async (opts: unknown) => {
    fixture.textCalls.push(opts);
    return fixture.textValue;
  },
  select: async (opts: unknown) => {
    fixture.selectCalls.push(opts);
    return fixture.selectValue;
  },
  confirm: async (opts: unknown) => {
    fixture.confirmCalls.push(opts);
    return fixture.confirmValue;
  },
  cancel: (msg: string) => {
    fixture.cancelCalls.push(msg);
  },
  isCancel: (v: unknown) => v === CANCEL_SENTINEL,
}));

const importRunWizard = async () => {
  const mod = await import("./prompts.ts");
  return mod.runWizard;
};

describe("runWizard", () => {
  test("returns the same values back when all inputs are pre-filled (no prompts)", async () => {
    resetFixture();
    const runWizard = await importRunWizard();
    const out = await runWizard({
      projectName: "my-app",
      target: "cloudflare",
      starter: "minimal",
      withAddons: [],
      install: false,
      git: false,
    });
    expect(out).toEqual({
      mode: "scaffold",
      projectName: "my-app",
      target: "cloudflare",
      starter: "minimal",
      withAddons: [],
      install: false,
      git: false,
    });
    expect(fixture.textCalls).toHaveLength(0);
    expect(fixture.selectCalls).toHaveLength(0);
    expect(fixture.confirmCalls).toHaveLength(0);
    expect(fixture.introCalls).toHaveLength(1);
  });

  test("returns the mocked text value when projectName is missing", async () => {
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = "cloudflare";
    fixture.confirmValue = true;
    const runWizard = await importRunWizard();
    const out = (await runWizard({})) as ScaffoldWizardOutput;
    expect(out.projectName).toBe("my-app");
    expect(out.target).toBe("cloudflare");
    expect(out.starter).toBe("cloudflare"); // mock returns selectValue for both target + starter selects
    expect(out.withAddons).toEqual([]);
    expect(out.install).toBe(true);
    expect(fixture.textCalls).toHaveLength(1);
    // Two selects now: target + starter.
    expect(fixture.selectCalls).toHaveLength(2);
    expect(fixture.confirmCalls).toHaveLength(1);
  });

  test("fires the docker confirm when target === node and returns withAddons", async () => {
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = "node";
    // The mocked `confirm` returns the same value for every call;
    // both the docker confirm and the install confirm see `true`.
    fixture.confirmValue = true;
    const runWizard = await importRunWizard();
    const out = (await runWizard({ starter: "minimal" })) as ScaffoldWizardOutput;
    expect(out.target).toBe("node");
    expect(out.withAddons).toEqual(["docker"]);
    expect(out.install).toBe(true);
    // Docker confirm + install confirm → two calls.
    expect(fixture.confirmCalls).toHaveLength(2);
  });

  test("returns withAddons=[] when target === node and the docker confirm is declined", async () => {
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = "node";
    fixture.confirmValue = false;
    const runWizard = await importRunWizard();
    const out = (await runWizard({ starter: "minimal" })) as ScaffoldWizardOutput;
    expect(out.target).toBe("node");
    expect(out.withAddons).toEqual([]);
    expect(out.install).toBe(false);
    expect(fixture.confirmCalls).toHaveLength(2);
  });

  test("skips the docker confirm when withAddons is pre-filled", async () => {
    resetFixture();
    fixture.textValue = "my-app";
    fixture.confirmValue = true;
    const runWizard = await importRunWizard();
    const out = (await runWizard({
      target: "node",
      starter: "minimal",
      withAddons: ["docker"],
    })) as ScaffoldWizardOutput;
    expect(out.withAddons).toEqual(["docker"]);
    expect(out.install).toBe(true);
    // Only the install confirm fires — the docker confirm is skipped
    // because withAddons was pre-supplied.
    expect(fixture.confirmCalls).toHaveLength(1);
  });

  test("exits with code 1 when the user cancels at the text prompt", async () => {
    resetFixture();
    fixture.textValue = CANCEL_SENTINEL;
    const exitSpy = vi
      .spyOn(process, "exit")
      // Throw so the caller short-circuits like a real process.exit
      // would; the test then asserts on exit-code 1.
      .mockImplementation(((code?: number) => {
        throw new Error(`__exit:${code}`);
      }) as never);
    try {
      const runWizard = await importRunWizard();
      await expect(runWizard({})).rejects.toThrow(/__exit:1/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fixture.cancelCalls).toEqual(["Cancelled."]);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("exits with code 1 when the user cancels at the select prompt", async () => {
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = CANCEL_SENTINEL;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}`);
    }) as never);
    try {
      const runWizard = await importRunWizard();
      await expect(runWizard({ starter: "minimal" })).rejects.toThrow(/__exit:1/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("exits with code 1 when the user cancels at the confirm prompt", async () => {
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = "node";
    fixture.confirmValue = CANCEL_SENTINEL;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}`);
    }) as never);
    try {
      const runWizard = await importRunWizard();
      await expect(runWizard({ starter: "minimal" })).rejects.toThrow(/__exit:1/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("uses a project-name validator that mirrors scaffold.ts (regression)", async () => {
    // The `text()` prompt receives a `validate` callback. Pull it out
    // and run it through the same shapes that `scaffold.ts` accepts
    // or rejects, so future drift between the two regexes is caught
    // at review.
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = "cloudflare";
    fixture.confirmValue = true;
    const runWizard = await importRunWizard();
    await runWizard({ starter: "minimal" });
    expect(fixture.textCalls).toHaveLength(1);
    const opts = fixture.textCalls[0] as { validate: (raw: string) => string | undefined };
    // Empty: rejected with "non-empty" message.
    expect(opts.validate("")).toMatch(/non-empty/);
    // Uppercase: rejected.
    expect(opts.validate("MyApp")).toMatch(/lowercase/);
    // Space / `!`: rejected.
    expect(opts.validate("my app")).toMatch(/lowercase/);
    expect(opts.validate("my-app!")).toMatch(/lowercase/);
    // Leading dash: rejected (must start `[a-z0-9]`).
    expect(opts.validate("-foo")).toMatch(/lowercase/);
    // Valid shapes: pass.
    expect(opts.validate("my-app")).toBeUndefined();
    expect(opts.validate("my_app_2")).toBeUndefined();
    expect(opts.validate("a")).toBeUndefined();
    expect(opts.validate("0abc")).toBeUndefined();
  });

  test("validator accepts '.' as the current-directory shorthand", async () => {
    // Mirror of `scaffold.ts` accepting `projectName === "."`. The
    // wizard's validator short-circuits to `undefined` so the wizard
    // returns `"."` to the caller; `scaffold()` then derives `appName`
    // from `basename(cwd)`.
    resetFixture();
    fixture.textValue = "my-app";
    fixture.selectValue = "cloudflare";
    fixture.confirmValue = true;
    const runWizard = await importRunWizard();
    await runWizard({ starter: "minimal" });
    const opts = fixture.textCalls[0] as {
      message: string;
      validate: (raw: string) => string | undefined;
    };
    expect(opts.validate(".")).toBeUndefined();
    // The message advertises the shorthand.
    expect(opts.message).toMatch(/current directory/);
    // Anything else dot-shaped is still rejected, and the error
    // message points the user at the shorthand.
    const slashErr = opts.validate("./");
    expect(slashErr).toMatch(/lowercase/);
    expect(slashErr).toMatch(/current directory/);
    expect(opts.validate("..")).toMatch(/lowercase/);
    expect(opts.validate("./foo")).toMatch(/lowercase/);
  });

  test("skips the starter select when starter is pre-filled", async () => {
    resetFixture();
    fixture.confirmValue = true;
    const runWizard = await importRunWizard();
    const out = (await runWizard({
      projectName: "my-app",
      target: "cloudflare",
      starter: "react",
      withAddons: [],
      install: true,
    })) as ScaffoldWizardOutput;
    expect(out.starter).toBe("react");
    // No select calls fired: target was pre-filled, starter was pre-filled.
    expect(fixture.selectCalls).toHaveLength(0);
  });

  test("fires the starter select when starter is missing and returns the mocked value", async () => {
    resetFixture();
    // Pre-fill target so only the starter select fires (the mock returns
    // the same `selectValue` for every call — see fixture comment).
    fixture.selectValue = "react";
    fixture.confirmValue = false;
    const runWizard = await importRunWizard();
    const out = (await runWizard({
      projectName: "my-app",
      target: "cloudflare",
      withAddons: [],
      install: false,
    })) as ScaffoldWizardOutput;
    expect(out.starter).toBe("react");
    expect(fixture.selectCalls).toHaveLength(1);
  });

  test("starter select advertises both minimal and react with hints", async () => {
    resetFixture();
    fixture.selectValue = "minimal";
    fixture.confirmValue = false;
    const runWizard = await importRunWizard();
    await runWizard({
      projectName: "my-app",
      target: "cloudflare",
      withAddons: [],
      install: false,
    });
    expect(fixture.selectCalls).toHaveLength(1);
    const opts = fixture.selectCalls[0] as {
      message: string;
      initialValue: string;
      options: ReadonlyArray<{ value: string; label: string; hint: string }>;
    };
    expect(opts.initialValue).toBe("minimal");
    const values = opts.options.map((o) => o.value).toSorted();
    expect(values).toEqual(["minimal", "react"]);
    // Each option carries a non-empty hint so the user sees the one-line
    // description next to the label.
    for (const o of opts.options) {
      expect(o.hint.length).toBeGreaterThan(0);
    }
  });

  test("exits with code 1 when the user cancels at the starter prompt", async () => {
    resetFixture();
    fixture.selectValue = CANCEL_SENTINEL;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}`);
    }) as never);
    try {
      const runWizard = await importRunWizard();
      // Pre-fill projectName + target so the starter select is the first
      // prompt that returns the cancel sentinel.
      await expect(
        runWizard({
          projectName: "my-app",
          target: "cloudflare",
          withAddons: [],
          install: false,
        }),
      ).rejects.toThrow(/__exit:1/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fixture.cancelCalls).toEqual(["Cancelled."]);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
