/**
 * Build a JSON `Response` for `MockFetch` scripts: `body` is serialized
 * as-is (no envelope) with `content-type: application/json`.
 */
export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
