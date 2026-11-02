import {
  BaerlyError,
  createCurrentJson,
  decodeJsonBytes,
  type LogEntry,
  MAINTENANCE_MIN_LIVE_BYTES,
  MemoryStorage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { Writer } from "./writer.ts";

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_KEY = "app/test/tenant/t/manifests/tickets/log/0.json";

describe("Writer post-commit fate", () => {
  test.each(["throw", "reject"] as const)(
    "a maintenance dispatcher that fails by %s preserves the durable commit result",
    async (failure) => {
      const storage = new MemoryStorage();
      await createCurrentJson(storage, CURRENT_KEY, {
        ...logStateCurrentJson(),
        mean_entry_bytes: MAINTENANCE_MIN_LIVE_BYTES,
        snapshot_bytes: 0,
      });
      const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
      let dispatchCalls = 0;
      const context = createObservabilityContext({
        maintenance: {
          dispatch: () => {
            dispatchCalls++;
            const error = new BaerlyError("NetworkError", "maintenance dispatch unavailable");
            if (failure === "throw") {
              throw error;
            }
            return Promise.reject(error);
          },
        },
      });

      const outcome = await Promise.resolve(
        runWithContext(context, () =>
          writer.commit({
            op: "I",
            collection: "tickets",
            docId: "one",
            body: { _id: "one" },
          }),
        ),
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      expect(dispatchCalls).toBe(1);
      const durable = await storage.get(LOG_KEY);
      expect(durable).not.toBeNull();
      expect(decodeJsonBytes<LogEntry>(durable!.body)).toMatchObject({
        seq: 0,
        doc_id: "one",
        after: { _id: "one" },
      });
      expect(outcome).toMatchObject({ result: { entry: { seq: 0, doc_id: "one" } } });
      expect(
        context.recorder
          .snapshot()
          .counters.filter((c) => c.name === "db.write.maintenance_dispatch_failed_total")
          .reduce((acc, c) => acc + c.value, 0),
      ).toBe(1);
    },
  );
});
