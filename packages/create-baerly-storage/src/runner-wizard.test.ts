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

/**
 * Silence a write stream for the duration of a call, capturing what
 * would have been written. The wizard branch forces `isTTY = true`, so
 * `runCreateBaerly` takes the interactive `outro(...)` path and emits a
 * clack banner (`✓ … / Next steps`) — without this it would bleed onto
 * the test tty. Mirrors the helper in `index.test.ts` / `cost.test.ts`.
 */
const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
};

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
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCreateBaerly([]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
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
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    try {
      await runCreateBaerly(["--starter=react", "--target=cloudflare"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(runWizardMock).toHaveBeenCalledTimes(1);
    const input = runWizardMock.mock.calls[0]?.[0];
    expect(input?.starter).toBe("react");
    expect(input?.target).toBe("cloudflare");
  });
});
