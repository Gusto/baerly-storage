/**
 * A {@link Writer} whose commits run with write-tick maintenance disabled
 * (`BAERLY_MAINTENANCE_DISABLE`'s path: no fold, no GC, only the bounded
 * `tail_hint` refresh). For tests that seed a log tail to hand to
 * `compact()`, `runGc()` or a read: a bare `Writer` maintains in-band, and
 * its write tick folds once the tail reaches the profile's
 * `foldAtTailEntries`, so a seeded tail longer than that would not stay
 * unfolded.
 */

import { type CommitInput, type CommitResult, Writer } from "../../packages/server/src/writer.ts";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";

const UNTICKED = createObservabilityContext({ maintenance: { disabled: true } });

export class UntickedWriter extends Writer {
  override commit(input: CommitInput): Promise<CommitResult> {
    return Promise.resolve(runWithContext(UNTICKED, () => super.commit(input)));
  }
}
