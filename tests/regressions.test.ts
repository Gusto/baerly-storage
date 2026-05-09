import { afterEach, describe, expect, test, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { type FetchFn, S3ClientLite } from "../src/s3-client-lite";
import { MPS3, type ResolvedMPS3Config } from "../src/mps3";
import { MPS3Error } from "../src/errors";
import {
    S3_REQUEST_MAX_RETRIES,
    SESSION_ID_LENGTH,
    SYNCER_CLOCK_SKEW_MAX_RETRIES,
} from "../src/constants";
import { uuid } from "../src/types";
import { reset } from "../src/memory-fetch";

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

    describe("clock-skew retry bound (Syncer.updateContent)", () => {
        afterEach(() => {
            reset();
        });

        test("rejects with NetworkError after the retry budget is exhausted", async () => {
            const mps3 = new MPS3({
                label: "skew",
                defaultBucket: `skew-${Math.random().toString(36).slice(2, 8)}`,
                pollFrequency: 60_000,
                minimizeListObjectsCalls: false,
                offlineStorage: false,
                adaptiveClock: true,
                parser: new DOMParser(),
                s3Config: { endpoint: MPS3.MEMORY_ENDPOINT },
            });

            // Each PUT response carries an ever-growing date offset, so the
            // syncer's clockOffset adjustment never converges and every
            // retry sees a fresh out-of-window manifest. After
            // SYNCER_CLOCK_SKEW_MAX_RETRIES the loop must bail.
            let skewBoost = 60_000;
            const original = (mps3.s3ClientLite as unknown as {
                putObject: (cmd: unknown) => Promise<{ Date: Date } & Record<string, unknown>>;
            }).putObject.bind(mps3.s3ClientLite);
            (mps3.s3ClientLite as unknown as {
                putObject: (cmd: unknown) => Promise<{ Date: Date } & Record<string, unknown>>;
            }).putObject = async (cmd) => {
                const result = await original(cmd);
                result.Date = new Date(Date.now() + skewBoost);
                skewBoost += 60_000;
                return result;
            };

            await expect(mps3.put("skew-key", "value")).rejects.toMatchObject({
                code: "NetworkError",
                message: expect.stringContaining(`${SYNCER_CLOCK_SKEW_MAX_RETRIES}`),
            });

            mps3.shutdown();
        });
    });

    describe("session-ID collisions", () => {
        test("collision rate below 1% at N=100", () => {
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
