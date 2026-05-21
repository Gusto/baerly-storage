import { createBaerlyClient } from "baerly-storage/client";

// Same-origin baseUrl: in dev, @cloudflare/vite-plugin runs the Worker
// inside workerd on this Vite process. The `baerlyDevAuth` plugin in
// vite.config.ts injects Authorization on /v1/* requests, so this
// file never sees the bearer token.
const client = createBaerlyClient({ baseUrl: "" });

const root = document.querySelector<HTMLDivElement>("#app");
if (root !== null) {
  root.innerHTML = `<h1>minimal-cloudflare</h1><p>Pinging server…</p>`;
  fetch("/v1/healthz")
    .then((res) => {
      root.innerHTML = `
        <h1>minimal-cloudflare</h1>
        <p>Server says: <code>${res.status} ${res.statusText}</code></p>
        <p>Edit <code>src/web/main.ts</code> to start calling
          <code>client.table(...)</code>.</p>
      `;
    })
    .catch((err: unknown) => {
      root.innerHTML = `<h1>minimal-cloudflare</h1><pre>${String(err)}</pre>`;
    });
}

// Keep the client import alive for users extending this file.
void client;
