/**
 * Tests for `eval/check-acceptance.mjs`.
 *
 * Shells out to the script (rather than importing it) — the contract
 * under test is the CLI surface: exit code, the JSON written to stdout,
 * and the per-bullet pass/fail dispatch. Fixtures live under
 * `tests/fixtures/check-acceptance/` and stay small enough to read
 * by eye.
 */
import { describe, test, expect } from "vitest";
import { execa } from "execa";

const SCRIPT = "eval/check-acceptance.mjs";
const FIXTURE_DIR = "tests/fixtures/check-acceptance";

describe("eval/check-acceptance.mjs", () => {
  test("happy-path todo fixture — all testable bullets pass, spa_renders is null", async () => {
    const result = await execa("node", [SCRIPT, "todo", `${FIXTURE_DIR}/todo-happy/`]);
    expect(result.exitCode).toBe(0);

    const doc = JSON.parse(result.stdout);
    expect(doc.schema_version).toBe(1);
    expect(doc.app).toBe("todo");
    expect(Array.isArray(doc.bullets)).toBe(true);

    const byId = new Map<string, { pass: boolean | null; stderr: string }>();
    for (const b of doc.bullets) byId.set(b.id, b);

    const ids = [
      "typecheck",
      "lint",
      "test",
      "no_raw_access",
      "uses_table_api",
      "verifier_wired",
      "crud_routes_present",
    ];
    for (const id of ids) {
      const b = byId.get(id);
      expect(b, `bullet ${id} missing`).toBeDefined();
      expect(b!.pass, `bullet ${id} should pass`).toBe(true);
    }
    const spa = byId.get("spa_renders");
    expect(spa).toBeDefined();
    expect(spa!.pass).toBeNull();
  });

  test("failing verify — typecheck bullet flips false with non-empty stderr", async () => {
    const result = await execa("node", [SCRIPT, "todo", `${FIXTURE_DIR}/todo-no-verify/`]);
    expect(result.exitCode).toBe(0);

    const doc = JSON.parse(result.stdout);
    const tc = doc.bullets.find((b: { id: string }) => b.id === "typecheck");
    expect(tc).toBeDefined();
    expect(tc.pass).toBe(false);
    expect(typeof tc.stderr).toBe("string");
    expect(tc.stderr.length).toBeGreaterThan(0);
  });

  test("db._raw usage — no_raw_access bullet flips false", async () => {
    const result = await execa("node", [SCRIPT, "todo", `${FIXTURE_DIR}/todo-uses-raw/`]);
    expect(result.exitCode).toBe(0);

    const doc = JSON.parse(result.stdout);
    const raw = doc.bullets.find((b: { id: string }) => b.id === "no_raw_access");
    expect(raw).toBeDefined();
    expect(raw.pass).toBe(false);
    expect(raw.stderr).toMatch(/_raw/);
  });

  test("unknown app — exit 1 and stderr lists valid app names", async () => {
    const result = await execa("node", [SCRIPT, "garbage"], {
      reject: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown app/);
    for (const app of ["todo", "notes", "rsvp", "chat", "shortlink", "kanban", "bookmarks"]) {
      expect(result.stderr).toContain(app);
    }
  });
});
