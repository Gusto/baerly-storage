import { createBaerlyClient } from "@gusto/baerly-storage/client";
import config from "../../baerly.config.ts";
import type { Note } from "../../types.ts";

// Same-origin baseUrl: `baerlyDev()` in vite.config.ts mounts the Node
// HTTP listener as Connect middleware on the same Vite process that
// serves this SPA, and injects Authorization server-side — so this
// file never sees the bearer token.
const client = createBaerlyClient({ baseUrl: "", config });

const app = document.querySelector<HTMLDivElement>("#app");
if (app === null) {
  throw new Error("missing #app root");
}

const render = async (): Promise<void> => {
  const notes = await client.table<Note>("notes").all();
  app.innerHTML = `<h1>minimal-node</h1><p>${notes.length} note(s)</p><button id="add">Add note</button>`;
  // innerHTML above replaced the previous button along with everything
  // else, so the new #add has no listener yet — attach a fresh one.
  app.querySelector("#add")?.addEventListener("click", async () => {
    // `_id` is auto-stamped UUIDv7 — sortable by server mint time, no separate timestamp column needed.
    await client.table<Note>("notes").insert({ body: "note" });
    await render();
  });
};

await render();
