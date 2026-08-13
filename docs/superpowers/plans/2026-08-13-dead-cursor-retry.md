# Dead-Cursor Retry Damping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated replacement-cursor rejection from resetting the
React subscription pool to its initial retry delay after every successful
empty-cursor bootstrap.

**Architecture:** Keep one retry counter for the table-poll loop and add one
local boolean recording that dead-cursor recovery is not yet proven. Capture
the cursor used for each request so only a successful request made with a
non-empty replacement cursor clears that state and resets backoff.

**Tech Stack:** TypeScript, Vitest fake timers, pnpm, oxfmt, oxlint.

## Global Constraints

- Keep the equal-jitter retry bounds at 250 ms initial and 10 seconds maximum.
- Preserve the existing reset after an ordinary successful poll.
- Preserve automatic empty-cursor bootstrap and query invalidation after a
  dead-cursor `SchemaError`.
- Add no public API, wire-protocol change, or dependency.
- Do not push the resulting commit without explicit authorization.

---

### Task 1: Carry backoff across unproven dead-cursor bootstrap

**Files:**

- Modify: `packages/client/src/react/subscription-pool.test.ts`
- Modify: `packages/client/src/react/subscription-pool.ts`
- External update: PR #126 description

**Interfaces:**

- Consumes: `pollSinceOnce(ctx, table, cursor, signal)` and the existing
  `retryDelay(attempt)` / `waitForRetry(delay, signal)` helpers.
- Produces: no new exported interface; only table-poll-local recovery state.

- [ ] **Step 1: Replace the loose oscillation assertion with a failing timing
      contract.**

  Rename the test to
  `a repeatedly rejected replacement cursor retains backoff across bootstrap success`.
  Record `Date.now()` for every `/v1/since` call, set system time to `0`, and
  make `Math.random()` return `0`. Keep the alternating empty-cursor success
  and non-empty-cursor `SchemaError` responses. Assert the literal schedule:

  ```ts
  expect(callTimes).toEqual([0, 0]);
  await vi.advanceTimersByTimeAsync(125);
  expect(callTimes).toEqual([0, 0, 125, 125]);
  await vi.advanceTimersByTimeAsync(125);
  expect(callTimes).toEqual([0, 0, 125, 125]);
  await vi.advanceTimersByTimeAsync(125);
  expect(callTimes).toEqual([0, 0, 125, 125, 375, 375]);
  await vi.advanceTimersByTimeAsync(500);
  expect(callTimes).toEqual([0, 0, 125, 125, 375, 375, 875, 875]);
  ```

  The production mutation this catches is resetting `retryAttempt` after the
  empty-cursor bootstrap even though the replacement cursor has not succeeded.

- [ ] **Step 2: Run the focused test and verify RED.**

  Run:

  ```sh
  pnpm test:agent packages/client/src/react/subscription-pool.test.ts
  ```

  Expected: the renamed oscillation test fails at simulated time 250 ms
  because the current implementation has already issued another bootstrap and
  rejected-cursor pair.

- [ ] **Step 3: Implement the minimal recovery-state distinction.**

  In `startTablePoll`, add `let deadCursorRecoveryPending = false` next to
  `retryAttempt`. At the top of each loop iteration capture
  `const requestCursor = poll.cursor` and pass it to `pollSinceOnce`.

  When the dead-cursor `SchemaError` branch clears `poll.cursor`, also set
  `deadCursorRecoveryPending = true`. Replace the unconditional success reset
  with:

  ```ts
  if (!deadCursorRecoveryPending || requestCursor !== "") {
    retryAttempt = 0;
    deadCursorRecoveryPending = false;
  }
  ```

  This leaves normal successful polls unchanged and treats an empty-cursor
  success during recovery only as receipt of a candidate replacement cursor.

- [ ] **Step 4: Run the focused test and verify GREEN.**

  Run:

  ```sh
  pnpm test:agent packages/client/src/react/subscription-pool.test.ts
  ```

  Expected: all subscription-pool tests pass, including the existing transport
  test that proves a normal success resets backoff.

- [ ] **Step 5: Update the PR description.**

  Replace “Preserves bounded retry for transport failures and dead-cursor
  SchemaError recovery” with prose that explicitly states retriable transport
  failures use equal-jitter exponential backoff with a 250 ms initial bound
  and 10 second cap, and that repeated replacement-cursor rejection retains
  backoff across empty-cursor bootstrap.

- [ ] **Step 6: Run repository verification.**

  Run, without piping output:

  ```sh
  pnpm verify:agent
  pnpm bundle-sizes
  pnpm test:agent
  ```

  Expected: all commands exit zero. Report any known load-sensitive timeout
  separately rather than claiming it passed.

- [ ] **Step 7: Commit the local changes.**

  Stage only the design, plan, test, and implementation files. Inspect
  `git status --short`, `git diff --cached --stat`, and `git diff --cached`
  before committing with:

  ```sh
  git commit -m "fix(react): damp dead-cursor retry oscillation"
  ```

  Do not push. Report the commit hash and ask for explicit push permission.
