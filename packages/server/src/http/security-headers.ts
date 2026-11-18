/**
 * Add `X-Content-Type-Options: nosniff` so a browser never renders a
 * JSON body or a static asset as a type other than its `Content-Type`.
 * The adapters apply it to every response they send.
 *
 * A `Response` from `fetch()` has immutable headers; that case is
 * re-wrapped (same body stream, status, and headers) before setting.
 */
export const withNosniff = (res: Response): Response => {
  if (res.headers.get("x-content-type-options") === "nosniff") {
    return res;
  }
  try {
    res.headers.set("x-content-type-options", "nosniff");
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set("x-content-type-options", "nosniff");
    return copy;
  }
};
