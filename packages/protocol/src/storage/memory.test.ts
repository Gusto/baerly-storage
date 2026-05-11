import { defineStorageConformanceSuite } from "./conformance";
import { MemoryStorage } from "./memory";

// `caseSensitiveKeys: true` is the in-memory impl's behavior — keys
// are stored verbatim in a `Map<string, …>`. The default in
// `ConformanceOptions` matches; pinned here for explicit documentation.
defineStorageConformanceSuite("MemoryStorage", async () => ({ storage: new MemoryStorage() }), {
  caseSensitiveKeys: true,
});
