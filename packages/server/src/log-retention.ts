/**
 * Sequence-based log retention.
 *
 * Log keys are derivable, so retirement uses a half-open sequence range rather
 * than LIST-based discovery. This module computes the range only; PR 5 owns the
 * deletion and delete-floor advance.
 */

import {
  type CurrentJson,
  LOG_RETENTION_MAX_DELETES_PER_TICK,
  LOG_RETENTION_SEQ_WINDOW,
  logDeleteFloorOf,
  logSeqStartOf,
} from "@baerly/protocol";

/** A half-open `[start, end)` sequence range. Empty when equal. */
export interface RetirableRange {
  readonly start: number;
  readonly end: number;
}

/** Compute the budgeted prefix of the currently retirable log range. */
export const computeRetirableRange = (
  current: CurrentJson,
  opts?: { window?: number; maxDeletes?: number },
): RetirableRange => {
  const window = opts?.window ?? LOG_RETENTION_SEQ_WINDOW;
  const maxDeletes = opts?.maxDeletes ?? LOG_RETENTION_MAX_DELETES_PER_TICK;
  const liveFloor = logSeqStartOf(current);
  const start = Math.min(logDeleteFloorOf(current), liveFloor);
  const boundary = Math.min(liveFloor - window, liveFloor);
  const end = Math.max(start, Math.min(boundary, start + maxDeletes));
  return { start, end };
};
