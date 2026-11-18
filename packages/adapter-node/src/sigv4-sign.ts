import type { AwsClient } from "aws4fetch";

/**
 * Sign an S3 request through `aws4fetch` without touching its body.
 *
 * Given a `Request` with a `Content-Type` and no `X-Amz-Content-Sha256`,
 * `AwsClient.sign` reads the whole body through `req.clone().arrayBuffer()`
 * and rebuilds the request around the copy, although for S3 it signs
 * `UNSIGNED-PAYLOAD` and never hashes the body. Signing only the method,
 * URL and headers yields the same `Authorization` and header set without
 * that copy. The header defaults to `UNSIGNED-PAYLOAD` exactly as
 * `aws4fetch` defaults it for S3, so the signature is unchanged.
 *
 * The signed headers go back onto a `Request` built from the original, so
 * the original body source survives and Node still sends a `Content-Length`.
 * Handing `aws4fetch` the original `Request` with `X-Amz-Content-Sha256`
 * already set would skip the copy too, but it rebuilds the request around
 * `req.body` (a `ReadableStream`), and undici then sends
 * `Transfer-Encoding: chunked` with no length, which AWS S3 `PutObject`
 * rejects.
 */
export async function signHeadersOnly(client: AwsClient, req: Request): Promise<Request> {
  const headers = new Headers(req.headers);
  if (!headers.has("X-Amz-Content-Sha256")) {
    headers.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
  }
  const signed = await client.sign(req.url, { method: req.method, headers });
  return new Request(req, { headers: signed.headers });
}
