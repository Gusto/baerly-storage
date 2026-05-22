// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/" }
//
// Regression-pinned contract: `init()` mounts the shell ONCE and
// `renderList(notes)` only repaints the `<ul id="list">`. A
// refresh-driven re-render must NOT blow away a half-typed `#body`
// input — which would happen the moment anyone reverts the file to a
// `root.innerHTML = '<form>…</form>…'` style render() (and then wires
// `setInterval(refresh, 5000)` per the scaffold's eventual-consistency
// guidance).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], _meta: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("renderList preserves typed input across an auto-refresh tick", async () => {
  // Importing main.ts triggers `init()` at the bottom, which mounts
  // the shell (h1 / form / ul#list) and kicks an initial refresh().
  const { renderList } = await import("./main.ts");

  // Drain the bootstrap refresh()'s microtask chain so it lands.
  await new Promise<void>((r) => setTimeout(r, 0));

  const input = document.querySelector<HTMLInputElement>("#body");
  expect(input, "form input mounted by init()").not.toBeNull();
  input!.value = "half-written note";

  // A subsequent refresh tick arrives with new rows.
  renderList([{ _id: "1", body: "earlier", created_at: "2026-05-21T00:00:00Z" }]);

  expect(
    document.querySelector<HTMLInputElement>("#body")?.value,
    "typed input survives the list re-render",
  ).toBe("half-written note");
  expect(document.querySelectorAll("#list li")).toHaveLength(1);
});
