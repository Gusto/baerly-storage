import { BaerlyError } from "@baerly/protocol";

/**
 * Read and validate an EKS-projected service-account token file, shared by
 * {@link fromWebIdentity} and {@link fromEksPodIdentity}. Reads the file,
 * trims surrounding whitespace (the projected token has a trailing newline),
 * and rejects an empty result.
 *
 * A missing / unreadable / empty projected token is a deploy misconfig, not a
 * transient fault — so every failure is `InvalidConfig`, which short-circuits
 * the retry loop (see `PERMANENT_ERROR_CODES` in `s3-http.ts`) instead of
 * hammering the credential source. Error messages name the specific env var
 * so the misconfig is debuggable.
 */
export async function readProjectedToken(
  doReadFile: (path: string, encoding: "utf8") => Promise<string>,
  tokenPath: string,
  ctx: { provider: string; envVar: string },
): Promise<string> {
  let rawToken: string;
  try {
    rawToken = await doReadFile(tokenPath, "utf8");
  } catch (error) {
    throw new BaerlyError(
      "InvalidConfig",
      `${ctx.provider}: cannot read ${ctx.envVar} (${tokenPath}): ${(error as Error).message}`,
    );
  }
  const token = rawToken.trim();
  if (token === "") {
    throw new BaerlyError(
      "InvalidConfig",
      `${ctx.provider}: ${ctx.envVar} (${tokenPath}) is empty`,
    );
  }
  return token;
}
