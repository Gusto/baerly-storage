import { createBaerlyClient } from "baerly-storage/client";

// The Vite dev server proxies /v1/* to the Node server; baseUrl is
// "" so requests stay same-origin. In a production CF Worker
// deploy, swap baseUrl to the deployed Worker URL.
const SECRET = import.meta.env.VITE_HELPDESK_SECRET ?? "dev-helpdesk-secret";

export const client = createBaerlyClient({
  baseUrl: "",
  headers: { Authorization: `Bearer ${SECRET}` },
});
