Write a retry helper for storage operations:

`export async function withRetry<T>(op: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T>`

It calls `op` up to 3 times in total. It retries only when the thrown error
is a library error that the library itself marks as safe to retry. When
the error carries a suggested delay in seconds, call `sleep` with that
delay in milliseconds before the next attempt; otherwise call `sleep(100)`.
Any other error, including errors that are not safe to retry, is rethrown
immediately without calling `sleep`. After the third failed attempt,
rethrow the last error.

Export it from `solution.ts`; no `main` is needed. Use only the documented
API.
