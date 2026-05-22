import { createBaerlyClient } from "baerly-storage/client";
import config from "../../baerly.config.ts";
import type { Note } from "../../types.ts";

// Same-origin baseUrl: in dev, @cloudflare/vite-plugin runs the
// Worker inside workerd on this Vite process. The `baerlyDevAuth`
// plugin in vite.config.ts injects Authorization on /v1/* requests,
// so this file never sees the bearer token. Passing `config` lets
// `client.table("notes")` infer the row type from baerly.config.ts.
const client = createBaerlyClient({ baseUrl: "", config });

// The shell (h1 / form / ul) is mounted ONCE by `init()`; subsequent
// refreshes only repaint the <ul id="list"> via `renderList(...)`. If
// you instead reach for `root.innerHTML = ...` to re-render, you'll
// blow away any half-typed text in #body — which matters as soon as
// you wire `setInterval(refresh, 5000)` for auto-refresh.
let listEl: HTMLUListElement | null = null;

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const renderList = (notes: ReadonlyArray<Note>): void => {
  if (listEl === null) {
    return;
  }
  listEl.innerHTML = notes
    .map((n) => `<li>${escapeHtml(n.body)} <small>${n.created_at}</small></li>`)
    .join("");
};

const refresh = (): void => {
  void client
    .table<Note>("notes")
    .all()
    .then((rows) => renderList([...rows].toReversed()))
    .catch(showError);
};

const showError = (err: unknown): void => {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (root !== null) {
    root.innerHTML = `<h1>minimal-cloudflare</h1><pre>${escapeHtml(String(err))}</pre>`;
    listEl = null;
  }
};

export const init = (): void => {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (root === null) {
    throw new Error("missing #app root");
  }
  root.innerHTML = `
    <h1>minimal-cloudflare</h1>
    <p>Stored in R2 via baerly-storage. Edit
      <code>src/web/main.ts</code> to extend.</p>
    <form id="add">
      <input id="body" placeholder="Write a note…" autocomplete="off" />
      <button type="submit">Add</button>
    </form>
    <ul id="list"></ul>
  `;
  listEl = root.querySelector<HTMLUListElement>("#list");
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
      .then(() => {
        if (input !== null) {
          input.value = "";
        }
        refresh();
      })
      .catch(showError);
  });
  refresh();
};

init();
