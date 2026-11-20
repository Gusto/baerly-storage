import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 2_000 });

const invalidOptions = [
  "--min-fanout=0",
  "--min-fanout=1",
  "--min-fanout=2.5",
  "--min-fanout=Infinity",
  "--max-fanout=16",
  "--max-fanout=32.5",
  "--max-fanout=-Infinity",
  "--leaf-bytes=0",
  "--leaf-bytes=-1",
  "--leaf-bytes=16384,",
  "--leaf-bytes=,16384",
  "--leaf-bytes=16384,,65536",
  "--leaf-bytes=Infinity",
  "--leaf-bytes=1.5",
  "--leaf-bytes=9007199254740992",
  "--min-fill=0",
  "--min-fill=-0.5",
  "--min-fill=1.01",
  "--min-fill=NaN",
  "--min-fill=Infinity",
  "--t-bytes=-1",
  "--t-rows=0.5",
  "--tail=-200",
  "--tail=Infinity",
  "--tail=",
  "--lag=-1",
  "--lag=1.5",
  "--neighbors=-1",
  "--splits=NaN",
  "--concurrent=-1",
  "--concurrent=9007199254740992",
  "--sharing=other",
  "--write-read=other",
];

describe("tree op-count CLI input validation", () => {
  test.each(invalidOptions)("refuses %s before producing a verdict", (arg) => {
    const result = run([arg]);
    // A timeout is a failure: invalid fanout must terminate with an error.
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(arg.slice(2, arg.indexOf("=")));
  });

  test.each(
    [
      [],
      [
        "--leaf-bytes=32768,65536",
        "--min-fill=1",
        "--min-fanout=4",
        "--max-fanout=Infinity",
        "--t-bytes=0",
        "--t-rows=0",
        "--tail=0",
        "--lag=0",
        "--neighbors=0",
        "--splits=0",
        "--concurrent=0",
        "--sharing=shared",
        "--write-read=scan",
      ],
      ["--min-fanout=4", "--max-fanout=128"],
    ].map((args) => ({ args })),
  )("prints finite verdicts for valid parameters $args", ({ args }) => {
    const result = run(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[1] Paid, Paid C/E");
    expect(result.stdout).toContain("[3] Free + R2 reads");
    expect(result.stdout).not.toContain("NaN");
  });
});

// Exercise the model directly: CLI validation must not be the only guard
// against a fanout that cannot increase capacity as depth grows.
test.each([0, 1])("canonicalDepth rejects non-growing fanout %i", (minFanout) => {
  const model = new URL("./model.ts", import.meta.url).href;
  const source = `import { canonicalDepth, PROTOTYPE_TREE_DEFAULTS, PAID_COLLECTION } from ${JSON.stringify(model)};
    try {
      canonicalDepth({ ...PROTOTYPE_TREE_DEFAULTS, minFanout: ${minFanout} }, PAID_COLLECTION);
      process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 2_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
});
