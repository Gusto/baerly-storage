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

// URL-aware fetch stub. The read endpoints (`GET /v1/t/<table>`,
// `GET /v1/t/<table>/<id>`, `GET /v1/count`) return the
// `{ data, _meta }` envelope; `GET /v1/since` returns the long-poll
// envelope `{ events: [], next_cursor: "" }`. A naive single-shape
// stub would TypeError the moment anyone wires `client.since(...)`
// into `main.ts` for live updates.
const resolveFetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const stubBaerlyFetch = (): typeof fetch =>
  vi.fn<typeof fetch>(async (input) => {
    const pathname = new URL(resolveFetchUrl(input), "http://localhost").pathname;
    const body = pathname.startsWith("/v1/since")
      ? { events: [], next_cursor: "" }
      : { data: [], _meta: {} };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("fetch", stubBaerlyFetch());
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
