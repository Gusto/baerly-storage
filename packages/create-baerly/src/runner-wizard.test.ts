/**
 * Tests the runner's wizard branch — the path `index.test.ts`
 * explicitly skips because vitest forks have `process.stdin.isTTY ===
 * undefined`. Here we force `isTTY = true`, mock `./prompts.ts` so
 * `runWizard` returns a controlled `WizardOutput`, and mock
 * `./scaffold.ts` so we can assert exactly what arguments
 * `runCreateBaerly` forwards. No real scaffold is written.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as ScaffoldModule from "./scaffold.ts";
import { runWizard } from "./prompts.ts";
import { scaffold } from "./scaffold.ts";
import { runCreateBaerly } from "./runner.ts";

vi.mock("./prompts.ts", () => ({
  runWizard: vi.fn<typeof runWizard>(),
}));
vi.mock("./scaffold.ts", async () => {
  const actual = await vi.importActual<typeof ScaffoldModule>("./scaffold.ts");
  return {
    ...actual,
    scaffold: vi.fn<typeof scaffold>(),
  };
});

const runWizardMock = vi.mocked(runWizard);
const scaffoldMock = vi.mocked(scaffold);

describe("runner wizard → scaffold plumbing", () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    runWizardMock.mockReset();
    scaffoldMock.mockReset();
    scaffoldMock.mockResolvedValue({
      outDir: "/tmp/scaffold-stub",
      filesWritten: [],
      nextSteps: [],
      cliVersion: "0.0.0-stub",
      appName: "stub",
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
  });

  test("passes the wizard's starter value to scaffold()", async () => {
    runWizardMock.mockResolvedValue({
      mode: "scaffold",
      projectName: "wizard-app",
      target: "cloudflare",
      starter: "react",
      withAddons: [],
      install: false,
      git: false,
    });
    // Omitting the positional `projectName` forces wantWizard=true.
    const code = await runCreateBaerly([]);
    expect(code).toBe(0);
    expect(scaffoldMock).toHaveBeenCalledTimes(1);
    const opts = scaffoldMock.mock.calls[0]?.[0];
    expect(opts?.starter).toBe("react");
    expect(opts?.projectName).toBe("wizard-app");
    expect(opts?.target).toBe("cloudflare");
  });

  test("forwards an explicit --starter flag into the wizard input", async () => {
    runWizardMock.mockResolvedValue({
      mode: "scaffold",
      projectName: "wizard-app",
      target: "cloudflare",
      starter: "react",
      withAddons: [],
      install: false,
      git: false,
    });
    // projectName missing → wizard fires; --starter=react is forwarded
    // as wizard input so the prompt can be skipped.
    await runCreateBaerly(["--starter=react", "--target=cloudflare"]);
    expect(runWizardMock).toHaveBeenCalledTimes(1);
    const input = runWizardMock.mock.calls[0]?.[0];
    expect(input?.starter).toBe("react");
    expect(input?.target).toBe("cloudflare");
  });
});
