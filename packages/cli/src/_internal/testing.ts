/**
 * @internal — test-only helpers for the CLI package, exposed to sibling
 * test files (relative import) and to `@gusto/create-baerly-storage`'s
 * tests via the `@baerly/cli/_internal/testing` subpath. Like
 * `@baerly/server/_internal/testing`, this subpath is intentionally NOT
 * in `publishConfig.exports`, so the published surface does not carry it.
 */

/**
 * Silence a write stream for the duration of a call, capturing what would
 * have been written to it. CLI commands write findings/banners to
 * `process.stdout` / `process.stderr`; tests swap `stream.write` for a
 * buffer, assert on `captured`, and always `restore()` in a `finally`.
 */
export const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
};
