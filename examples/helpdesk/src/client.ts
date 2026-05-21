import { createBaerlyClient } from "baerly-storage/client";

// `baerlyDev()` in vite.config.ts injects Authorization server-side,
// so this file never sees the bearer token.
export const client = createBaerlyClient({ baseUrl: "" });
