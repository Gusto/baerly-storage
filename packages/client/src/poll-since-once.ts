import { BaerlyError } from "@baerly/protocol";
import type { SinceResponse } from "./contract.ts";
import { type RequestContext, request } from "./request.ts";

/**
 * One round-trip of `GET /v1/since?collection=…&cursor=…`. The single
 * place that talks to `/v1/since` in this package — the React
 * `subscription-pool` is its only first-party consumer.
 *
 * Long-poll semantics live server-side: the call resolves once the
 * server's budget elapses (`{ events: [], next_cursor: <same> }`) or
 * one or more events arrive. Callers are expected to loop over this
 * helper, threading `next_cursor` through.
 *
 * `cursor === ""` means "start at `log_seq_start`" (the wire
 * protocol); pass the previously returned `next_cursor` to resume.
 *
 * `signal` cancels the underlying fetch via the standard
 * `AbortController` plumbing; the rejection propagates as
 * `AbortError`.
 */
export const pollSinceOnce = async (
  ctx: RequestContext,
  name: string,
  cursor: string,
  signal: AbortSignal | undefined,
): Promise<SinceResponse> => {
  const params = new URLSearchParams();
  params.set("collection", name);
  params.set("cursor", cursor);
  const response = await request<unknown>(ctx, {
    method: "GET",
    path: `/v1/since?${params.toString()}`,
    signal,
  });
  if (
    typeof response !== "object" ||
    response === null ||
    !("events" in response) ||
    !Array.isArray(response.events) ||
    !("next_cursor" in response) ||
    typeof response.next_cursor !== "string"
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      "Response to GET /v1/since must contain an events array and string next_cursor",
    );
  }
  return response as SinceResponse;
};
