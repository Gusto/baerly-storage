import {
  type DeleteValue,
  type JSONValue,
  type OMap,
  type ResolvedRef,
  type VersionId,
  type b64,
  url,
} from "@baerly/protocol";
import { MPS3 } from "./mps3";
import { Syncer } from "./syncer";

/**
 * Per-manifest write coordinator. Owns a {@link Syncer} which reads
 * and writes the manifest log. There is no background poller — callers
 * refresh explicitly by initiating a write (`updateContent`) or a read
 * (`getVersion`). Realtime is deferred to a Phase 10 `NotificationBus`.
 *
 * Don't change the manifest-key shape without reading
 * `docs/sync_protocol.md` first — the `<base32-time>_<session>_<seq>`
 * format is load-bearing for causal ordering.
 *
 * @see `docs/sync_protocol.md`
 * @see `docs/ARCHITECTURE.md` (lifecycle)
 */
export class Manifest {
  syncer: Syncer = new Syncer(this);
  service: MPS3;
  ref: ResolvedRef;

  constructor(service: MPS3, ref: ResolvedRef) {
    this.service = service;
    this.ref = ref;
  }

  updateContent(
    write: Promise<Map<ResolvedRef, VersionId | DeleteValue>>,
    options: {
      keys: OMap<
        ResolvedRef,
        {
          replication?: b64;
        }
      >;
      bodies?: Map<ResolvedRef, JSONValue | DeleteValue>;
    },
  ): Promise<unknown> {
    return this.syncer.updateContent(write, options);
  }

  async getVersion(ref: ResolvedRef): Promise<string | undefined> {
    return (await this.syncer.getLatest()).files[url(ref)]?.version;
  }
}
