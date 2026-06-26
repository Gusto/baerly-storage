/**
 * Test-side mirror of the host ports and Minio root credentials
 * docker-compose.yml binds. Default values match the compose defaults;
 * override per-worktree with environment variables to run two stacks on one
 * machine.
 *
 *   BAERLY_MINIO_HOST_PORT=9202 \
 *   BAERLY_TOXIPROXY_HOST_PORT=9204 \
 *   BAERLY_TOXIPROXY_ADMIN_PORT=8574 \
 *   BAERLY_POSTGRES_HOST_PORT=5434 \
 *     pnpm dev:storage
 *
 * Consumers should import these and never write the literal port or
 * credential. The point is exactly to make "what port is Minio on?" and
 * "what's the Minio key?" answerable in one place.
 *
 * The credentials are local-dev only — they authenticate the throwaway Minio
 * container `pnpm dev:storage` spins up on localhost and grant nothing in
 * production. Override the defaults with `BAERLY_MINIO_ROOT_USER` /
 * `BAERLY_MINIO_ROOT_PASSWORD` (the same vars docker-compose.yml reads).
 */
const num = (env: string, fallback: number): number => {
  const v = process.env[env];
  if (v === undefined || v === "") {
    return fallback;
  }
  const parsed = Number(v);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${env}=${v} is not a valid port number (expected integer in [1, 65535])`);
  }
  return parsed;
};

const str = (env: string, fallback: string): string => {
  const v = process.env[env];
  return v === undefined || v === "" ? fallback : v;
};

export const MINIO_ACCESS_KEY = str("BAERLY_MINIO_ROOT_USER", "baerly");
export const MINIO_SECRET_KEY = str("BAERLY_MINIO_ROOT_PASSWORD", "baerly-local-dev");

export const MINIO_HOST_PORT = num("BAERLY_MINIO_HOST_PORT", 9102);
export const TOXIPROXY_HOST_PORT = num("BAERLY_TOXIPROXY_HOST_PORT", 9104);
export const TOXIPROXY_ADMIN_PORT = num("BAERLY_TOXIPROXY_ADMIN_PORT", 8474);
export const POSTGRES_HOST_PORT = num("BAERLY_POSTGRES_HOST_PORT", 5433);

export const MINIO_ENDPOINT = `http://127.0.0.1:${MINIO_HOST_PORT}`;
export const TOXIPROXY_ENDPOINT = `http://127.0.0.1:${TOXIPROXY_HOST_PORT}`;
export const TOXIPROXY_ADMIN_ENDPOINT = `http://127.0.0.1:${TOXIPROXY_ADMIN_PORT}`;
