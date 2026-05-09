import { describe, expect, test, vi } from "vitest";
import { type FetchFn, S3ClientLite } from "../s3-client-lite";
import type { ResolvedMPS3Config } from "../mps3";
import { MPS3Error } from "../errors";
import { S3_REQUEST_MAX_RETRIES, SESSION_ID_LENGTH } from "../constants";
import { uuid } from "../types";

// Minimal stub. Only fields touched by S3ClientLite + time.adjustClock
// when `adaptiveClock: false` are populated; the rest are unused for
// these tests so a partial cast keeps the surface small.
const configStub = {
    log: () => {},
    adaptiveClock: false,
    clockOffset: 0,
    parser: undefined,
} as unknown as ResolvedMPS3Config;

describe("regressions (§9 bug-fix list)", () => {
    describe("retry bound (S3ClientLite.retry)", () => {
        test("transient failures stop after a bounded number of attempts", async () => {
            vi.useFakeTimers();
            try {
                let attempts = 0;
                const fetchFn: FetchFn = async () => {
                    attempts++;
                    throw new Error("transient");
                };
                const client = new S3ClientLite(fetchFn, "http://test", configStub);
                const promise = client.putObject({
                    Bucket: "b",
                    Key: "k",
                    Body: "{}",
                });
                // Surface unhandled rejection through the assertion below.
                promise.catch(() => {});
                await vi.runAllTimersAsync();
                await expect(promise).rejects.toThrow("transient");
                expect(attempts).toBe(S3_REQUEST_MAX_RETRIES + 1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("useChecksum flag", () => {
        // Today: `useChecksum` is computed in mps3.ts (~line 727) but the
        // resulting `x-amz-content-sha256` header is COMMENTED OUT on the
        // wire (S3ClientLite.ts:106). Half-dead. Phase 1 picks one:
        //   (a) honor the flag on the wire, or
        //   (b) remove `useChecksum` from the public type.
        // This `.todo` keeps the disposition on the agenda.
        test.todo(
            "useChecksum: either honored on the wire or removed from public type",
        );
    });

    describe("non-JSON 5xx error body", () => {
        test("returns InvalidResponse, not a SyntaxError", async () => {
            const fetchFn: FetchFn = async () =>
                new Response("<html>502 Bad Gateway</html>", {
                    status: 502,
                    headers: { "content-type": "text/html" },
                });
            const client = new S3ClientLite(fetchFn, "http://test", configStub);

            await expect(
                client.getObject({ Bucket: "b", Key: "k" }),
            ).rejects.toMatchObject({
                code: "InvalidResponse",
            });

            // Pin the typed-error invariant: must be MPS3Error, never a
            // raw SyntaxError leaking from `JSON.parse`.
            try {
                await client.getObject({ Bucket: "b", Key: "k" });
                expect.fail("expected throw");
            } catch (e) {
                expect(e).toBeInstanceOf(MPS3Error);
                expect(e).not.toBeInstanceOf(SyntaxError);
            }
        });
    });

    describe("session-ID collisions", () => {
        // Today: SESSION_ID_LENGTH=3, generator is uuid().substring(0,3).
        // crypto.randomUUID() returns a hex (base-16) string, so the keyspace
        // is 16^3 = 4096 — NOT 32^3 = 32 768 as the constants.ts doc claims.
        // Phase 3 either bumps SESSION_ID_LENGTH or moves to a Worker
        // request-id. Marked `.fails` so the test correctly tracks the bug:
        // when Phase 3 fixes it, this line becomes red and the marker is
        // removed.
        test.fails("collision rate below 1% at N=100", () => {
            const N = 100;
            const ids = new Set<string>();
            let collisions = 0;
            for (let i = 0; i < N; i++) {
                const sid = uuid().substring(0, SESSION_ID_LENGTH);
                if (ids.has(sid)) collisions++;
                ids.add(sid);
            }
            expect(collisions / N).toBeLessThan(0.01);
        });
    });
});
