import { createBaerlyClient } from "baerly-storage/client";
import config from "../../baerly.config.ts";
import type { Note } from "../../types.ts";

// Same-origin baseUrl: Vite's dev proxy forwards /v1/* to the Node
// server on :3000. `baerlyDevAuth` in vite.config.ts injects
// Authorization before the proxy hop, so this file never sees the
// bearer token. Passing `config` lets `client.table("notes")` infer
// the row type from baerly.config.ts.
const client = createBaerlyClient({ baseUrl: "", config });

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) {
  throw new Error("missing #app root");
}

const render = (notes: ReadonlyArray<Note>): void => {
  root.innerHTML = `
    <h1>minimal-node</h1>
    <p>Stored on the local filesystem (dev) or S3 (prod) via
      baerly-storage. Edit <code>src/web/main.ts</code> to extend.</p>
    <form id="add">
      <input id="body" placeholder="Write a note…" autocomplete="off" />
      <button type="submit">Add</button>
    </form>
    <ul>
      ${notes
        .map((n) => `<li>${escapeHtml(n.body)} <small>${n.created_at}</small></li>`)
        .join("")}
    </ul>
  `;
  const form = root.querySelector<HTMLFormElement>("#add");
  const input = root.querySelector<HTMLInputElement>("#body");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = input?.value.trim() ?? "";
    if (body.length === 0) {
      return;
    }
    void client
      .table<Note>("notes")
      .insert({ body, created_at: new Date().toISOString() })
      .then(refresh)
      .catch(showError);
  });
};

const refresh = (): void => {
  void client
    .table<Note>("notes")
    .all()
    .then((rows) => render([...rows].toReversed()))
    .catch(showError);
};

const showError = (err: unknown): void => {
  root.innerHTML = `<h1>minimal-node</h1><pre>${escapeHtml(String(err))}</pre>`;
};

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

refresh();
