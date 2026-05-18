/**
 * Programmatic Toxiproxy control via its HTTP admin API. Targets the
 * `minio` proxy that `docker-compose.yml`'s `toxiproxy-config-0`
 * one-shot service publishes on `:9104`. The admin API itself lives
 * on `:8474`.
 *
 * The bench installs toxics for `S3-toxic` scenarios and tears them
 * down after the run so back-to-back invocations don't leak state.
 */

import type { Network } from "./types.ts";

export const TOXIPROXY_ADMIN = "http://127.0.0.1:8474";
export const PROXY_NAME = "minio"; // matches docker-compose.yml

export async function isToxiproxyReady(): Promise<boolean> {
  try {
    const res = await fetch(`${TOXIPROXY_ADMIN}/proxies/${PROXY_NAME}`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearToxics(): Promise<void> {
  const res = await fetch(`${TOXIPROXY_ADMIN}/proxies/${PROXY_NAME}/toxics`);
  if (!res.ok) return; // proxy not yet registered, nothing to clear
  const toxics = (await res.json()) as Array<{ name: string }>;
  for (const t of toxics) {
    await fetch(`${TOXIPROXY_ADMIN}/proxies/${PROXY_NAME}/toxics/${t.name}`, {
      method: "DELETE",
    });
  }
}

export async function installToxics(network: Network): Promise<void> {
  await clearToxics();
  if (network === "direct") return;
  const cfgs: Array<Record<string, unknown>> =
    network === "wan-50ms"
      ? [
          {
            name: "latency_up",
            type: "latency",
            stream: "upstream",
            toxicity: 1.0,
            attributes: { latency: 50, jitter: 10 },
          },
          {
            name: "latency_down",
            type: "latency",
            stream: "downstream",
            toxicity: 1.0,
            attributes: { latency: 50, jitter: 10 },
          },
        ]
      : /* loss-5 */ [
          {
            name: "timeout_up",
            type: "timeout",
            stream: "upstream",
            toxicity: 0.05,
            attributes: { timeout: 1 },
          },
          {
            name: "timeout_down",
            type: "timeout",
            stream: "downstream",
            toxicity: 0.05,
            attributes: { timeout: 1 },
          },
        ];
  for (const cfg of cfgs) {
    const res = await fetch(`${TOXIPROXY_ADMIN}/proxies/${PROXY_NAME}/toxics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) {
      throw new Error(`bench: install toxic ${cfg["name"] as string} failed: ${res.status}`);
    }
  }
}
