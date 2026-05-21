import { createBaerlyClient } from "baerly-storage/client";

// Same-origin baseUrl: Vite's dev proxy forwards /v1/* to the Node
// server on :3000. `baerlyDevAuth` in vite.config.ts injects
// Authorization before the proxy hop, so this file never sees the
// bearer token.
const client = createBaerlyClient({ baseUrl: "" });

const root = document.querySelector<HTMLDivElement>("#app");
if (root !== null) {
  root.innerHTML = `<h1>minimal-node</h1><p>Pinging server…</p>`;
  fetch("/v1/healthz")
    .then((res) => {
      root.innerHTML = `
        <h1>minimal-node</h1>
        <p>Server says: <code>${res.status} ${res.statusText}</code></p>
        <p>Edit <code>src/web/main.ts</code> to start calling
          <code>client.table(...)</code>.</p>
      `;
    })
    .catch((err: unknown) => {
      root.innerHTML = `<h1>minimal-node</h1><pre>${String(err)}</pre>`;
    });
}

// Keep the client import alive for users extending this file.
void client;
