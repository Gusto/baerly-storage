import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  collectViolations,
  detectDependabotIgnores,
  detectLoosenings,
  detectSuppressions,
  STRICT_SETTINGS,
  validateRegister,
  type ExceptionEntry,
  type Loosening,
} from "../../scripts/check-exceptions.ts";

const TODAY = "2026-11-17";

const entry = (over: Partial<ExceptionEntry> = {}): ExceptionEntry => ({
  id: "audit-x",
  kind: "audit-ignore",
  files: ["pnpm-workspace.yaml"],
  subject: "GHSA-aaaa-bbbb-cccc",
  reason: "no patched release",
  revisit: "a patched release exists",
  expires: "2026-12-17",
  ...over,
});

const ignored: Loosening = {
  kind: "audit-ignore",
  file: "pnpm-workspace.yaml",
  subject: "GHSA-aaaa-bbbb-cccc",
};

const noPins = () => false;

const strictRoot = {
  trustPolicy: "no-downgrade",
  minimumReleaseAge: 1440,
  blockExoticSubdeps: true,
  strictPeerDependencies: true,
  engineStrict: true,
};

describe("detectLoosenings", () => {
  test("finds every loosening class in a workspace file", () => {
    const found = detectLoosenings("pnpm-workspace.yaml", {
      ...strictRoot,
      audit: { ignore: ["GHSA-aaaa-bbbb-cccc"] },
      overrides: { qs: ">=6.15.2" },
      packageExtensions: { "@stryker-mutator/core": {} },
      allowBuilds: { esbuild: true, workerd: false },
      ignoreWorkspaceCycles: true,
      trustPolicyExclude: ["foo@1.0.0"],
    });
    expect(found.map((l) => `${l.kind}:${l.subject}`).toSorted()).toEqual([
      "allow-build:esbuild",
      "audit-ignore:GHSA-aaaa-bbbb-cccc",
      "override:qs",
      "package-extension:@stryker-mutator/core",
      "setting:ignoreWorkspaceCycles",
      "setting:trustPolicyExclude",
    ]);
  });

  test("a strict workspace yields nothing", () => {
    expect(
      detectLoosenings("pnpm-workspace.yaml", {
        ...strictRoot,
        allowBuilds: { sharp: false },
        ignoreWorkspaceCycles: false,
        trustPolicyExclude: [],
      }),
    ).toEqual([]);
  });
});

describe("strict settings guard", () => {
  const weakened = (file: string, workspace: object) =>
    detectLoosenings(file, workspace)
      .filter((l) => l.subject.startsWith("weakened:"))
      .map((l) => l.subject);

  test("the strict baseline is clean at the root and in a template", () => {
    expect(weakened("pnpm-workspace.yaml", strictRoot)).toEqual([]);
    expect(weakened("examples/minimal-node/pnpm-workspace.yaml", strictRoot)).toEqual([]);
  });

  test.each([
    ["empty", ""],
    ["comments only", "# Install settings removed\n"],
    ["null", "null"],
    ["boolean", "true"],
    ["number", "42"],
    ["string", '"policy"'],
    ["sequence", "- trustPolicy\n- no-downgrade\n"],
  ])("%s policies report every missing required setting", (_name, yaml) => {
    const policy: unknown = parseYaml(yaml);
    for (const [file, count] of [
      ["pnpm-workspace.yaml", 5],
      ["examples/minimal-node/pnpm-workspace.yaml", 3],
    ] as const) {
      const found = detectLoosenings(file, policy);
      expect(found).toEqual(detectLoosenings(file, {}));
      expect(collectViolations([], found, noPins, TODAY)).toHaveLength(count);
    }
  });

  test.each([
    ["trustPolicy", { trustPolicy: "off" }],
    ["minimumReleaseAge", { minimumReleaseAge: 60 }],
    ["blockExoticSubdeps", { blockExoticSubdeps: false }],
    ["strictPeerDependencies", { strictPeerDependencies: false }],
    ["engineStrict", { engineStrict: false }],
    ["strictDepBuilds", { strictDepBuilds: false }],
    ["dangerouslyAllowAllBuilds", { dangerouslyAllowAllBuilds: true }],
  ])("a weakened %s at the root is reported", (name, change) => {
    expect(weakened("pnpm-workspace.yaml", { ...strictRoot, ...change })).toEqual([
      `weakened:${name}`,
    ]);
  });

  test.each(["trustPolicy", "minimumReleaseAge", "blockExoticSubdeps"])(
    "deleting %s is reported (an absent value is not strict enough)",
    (name) => {
      const { [name as keyof typeof strictRoot]: _gone, ...rest } = strictRoot;
      expect(weakened("pnpm-workspace.yaml", rest)).toEqual([`weakened:${name}`]);
    },
  );

  test("templates are only held to the settings they ship", () => {
    const template = {
      trustPolicy: "no-downgrade",
      minimumReleaseAge: 1440,
      blockExoticSubdeps: true,
    };
    expect(weakened("examples/minimal-node/pnpm-workspace.yaml", template)).toEqual([]);
    expect(
      weakened("examples/minimal-node/pnpm-workspace.yaml", { ...template, trustPolicy: "off" }),
    ).toEqual(["weakened:trustPolicy"]);
  });

  test("every strict setting has a test row above", () => {
    expect(Object.keys(STRICT_SETTINGS).toSorted()).toEqual([
      "blockExoticSubdeps",
      "dangerouslyAllowAllBuilds",
      "engineStrict",
      "minimumReleaseAge",
      "strictDepBuilds",
      "strictPeerDependencies",
      "trustPolicy",
    ]);
  });

  test("a weakening needs a register entry, and the entry goes with the weakening", () => {
    const l: Loosening = {
      kind: "setting",
      file: "pnpm-workspace.yaml",
      subject: "weakened:trustPolicy",
    };
    const e = entry({ id: "trust", kind: "setting", subject: "weakened:trustPolicy" });
    expect(collectViolations([], [l], noPins, TODAY).join("\n")).toMatch(
      /unregistered loosening: setting "weakened:trustPolicy"/,
    );
    expect(collectViolations([e], [l], noPins, TODAY)).toEqual([]);
    expect(collectViolations([e], [], noPins, TODAY).join("\n")).toMatch(/trust: no setting/);
  });
});

describe("dependabot and suppression detectors", () => {
  test("every dependabot ignore entry is a loosening (deleting the lefthook entry fails)", () => {
    const ignores = detectDependabotIgnores(".github/dependabot.yml", {
      updates: [
        {
          "package-ecosystem": "npm",
          ignore: [{ "dependency-name": "lefthook", versions: ["2.2.2"] }],
        },
        { "package-ecosystem": "docker" },
      ],
    });
    expect(ignores).toEqual([
      { kind: "dependabot-ignore", file: ".github/dependabot.yml", subject: "lefthook" },
    ]);
    const problems = collectViolations([], ignores, noPins, TODAY).join("\n");
    expect(problems).toMatch(/unregistered loosening: dependabot-ignore "lefthook"/);
  });

  test("zizmor ignore comments and config files are suppressions", () => {
    expect(
      detectSuppressions(".github/workflows/ci.yml", "uses: x # zizmor: ignore[artipacked]\n"),
    ).toHaveLength(1);
    expect(detectSuppressions(".github/zizmor.yml", "rules: {}\n")).toHaveLength(1);
    expect(detectSuppressions(".github/workflows/ci.yml", "uses: x\n")).toEqual([]);
  });
});

describe("collectViolations", () => {
  test("a registered, unexpired loosening is clean", () => {
    expect(collectViolations([entry()], [ignored], noPins, TODAY)).toEqual([]);
  });

  test("an expired entry fails", () => {
    const problems = collectViolations(
      [entry({ expires: "2026-11-16" })],
      [ignored],
      noPins,
      TODAY,
    );
    expect(problems.join("\n")).toMatch(/audit-x: expired on 2026-11-16/);
  });

  test("an entry that expires today is still valid", () => {
    expect(collectViolations([entry({ expires: TODAY })], [ignored], noPins, TODAY)).toEqual([]);
  });

  test("a loosening with no entry fails", () => {
    const problems = collectViolations([], [ignored], noPins, TODAY);
    expect(problems.join("\n")).toMatch(
      /unregistered loosening: audit-ignore "GHSA-aaaa-bbbb-cccc"/,
    );
  });

  test("an entry must list the file the loosening lives in", () => {
    const other: Loosening = { ...ignored, file: "examples/minimal-node/pnpm-workspace.yaml" };
    const problems = collectViolations([entry()], [ignored, other], noPins, TODAY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/unregistered loosening.*examples\/minimal-node/);
  });

  test("an entry whose loosening is gone fails", () => {
    const problems = collectViolations([entry()], [], noPins, TODAY);
    expect(problems.join("\n")).toMatch(
      /audit-x: no audit-ignore "GHSA-aaaa-bbbb-cccc".*Remove the entry/,
    );
  });

  test("a pin entry fails once its text is gone and passes while present", () => {
    const pin = entry({
      id: "pin-x",
      kind: "pin",
      files: ["package.json"],
      subject: '"lefthook": "2.2.1"',
    });
    expect(collectViolations([pin], [], () => true, TODAY)).toEqual([]);
    expect(collectViolations([pin], [], noPins, TODAY).join("\n")).toMatch(/pin-x: pin text/);
  });

  test("an external entry is checked for expiry only", () => {
    const ext = entry({ id: "ext", kind: "external", files: [] });
    expect(collectViolations([ext], [], noPins, TODAY)).toEqual([]);
    expect(collectViolations([{ ...ext, expires: "2026-01-01" }], [], noPins, TODAY)).toHaveLength(
      1,
    );
  });
});

describe("validateRegister", () => {
  test("rejects a non-array register", () => {
    expect(validateRegister({}, TODAY)).toEqual(["the register must be a JSON array of entries"]);
  });

  test("rejects a missing reason, a bad date, an unknown kind and duplicate ids", () => {
    const problems = validateRegister(
      [
        { ...entry(), reason: "" },
        { ...entry({ id: "b", expires: "soon" }) },
        { ...entry({ id: "c", kind: "mystery" as ExceptionEntry["kind"] }) },
        { ...entry({ id: "c" }) },
      ],
      TODAY,
    ).join("\n");
    expect(problems).toMatch(/audit-x: missing or empty "reason"/);
    expect(problems).toMatch(/b: "expires" must be a YYYY-MM-DD date/);
    expect(problems).toMatch(/c: unknown kind "mystery"/);
    expect(problems).toMatch(/c: duplicate id/);
  });

  test("a non-external entry needs at least one file", () => {
    expect(validateRegister([entry({ files: [] })], TODAY).join("\n")).toMatch(/at least one file/);
  });
});
