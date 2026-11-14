/**
 * Response header an admitted write carries when it leaves the collection
 * within `CAPACITY_WARN_FRACTION` (`constants.ts`) of its host's
 * growth-refusal point. The value is the warning text: it names the state
 * and the app-side remedy only. The same text rides the canonical log line
 * as `capacity_warning`. Absent when the collection has room.
 *
 * A zero-import leaf rather than an entry in `constants.ts`: the browser
 * client reads it, and importing `constants.ts` would pull that module's
 * kernel-tuning JSDoc into the client bundle.
 */
export const CAPACITY_WARNING_HEADER: string = "Baerly-Capacity-Warning";
