/**
 * Test-side mirror of the host ports docker-compose.yml binds. Default values
 * match the compose defaults; override per-worktree with environment variables
 * to run two stacks on one machine.
 *
 *   BAERLY_MINIO_HOST_PORT=9202 \
 *   BAERLY_TOXIPROXY_HOST_PORT=9204 \
 *   BAERLY_TOXIPROXY_ADMIN_PORT=8574 \
 *   BAERLY_POSTGRES_HOST_PORT=5434 \
 *     pnpm dev:storage
 *
 * Consumers should import these and never write the literal port. The point
 * is exactly to make "what port is Minio on?" answerable in one place.
 */
const num = (env: string, fallback: number): number => {
  const v = process.env[env];
  return v === undefined || v === "" ? fallback : Number(v);
};

export const MINIO_HOST_PORT = num("BAERLY_MINIO_HOST_PORT", 9102);
export const TOXIPROXY_HOST_PORT = num("BAERLY_TOXIPROXY_HOST_PORT", 9104);
export const TOXIPROXY_ADMIN_PORT = num("BAERLY_TOXIPROXY_ADMIN_PORT", 8474);
export const POSTGRES_HOST_PORT = num("BAERLY_POSTGRES_HOST_PORT", 5433);

export const MINIO_ENDPOINT = `http://127.0.0.1:${MINIO_HOST_PORT}`;
export const TOXIPROXY_ENDPOINT = `http://127.0.0.1:${TOXIPROXY_HOST_PORT}`;
export const TOXIPROXY_ADMIN_ENDPOINT = `http://127.0.0.1:${TOXIPROXY_ADMIN_PORT}`;
