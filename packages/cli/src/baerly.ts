/**
 * `baerly` — vendorless document database CLI.
 *
 * Hand-rolled `--key=value` arg parser. No short flags, no positional
 * args. This file is the precedent for every future subcommand: add
 * a new `case` arm in `main` and extend `HELP`.
 */
import { runCopy } from "./copy";

const HELP = `baerly — vendorless document database CLI

Usage:
  baerly copy --from=<bucket-uri> --from-snapshot=<cursor> --to=<bucket-uri>
  baerly --help

Subcommands:
  copy   Copy a snapshot bucket-to-bucket. Bypasses write-path
         compaction; emits one L9 snapshot at the target.

URI grammar:
  s3://<bucket>[/<prefix>]   S3-compatible HTTP via aws4fetch.
                             Requires BAERLY_S3_ENDPOINT,
                             BAERLY_S3_ACCESS_KEY_ID,
                             BAERLY_S3_SECRET_ACCESS_KEY env vars.
                             BAERLY_S3_REGION defaults to us-east-1.
  file:///<absolute-path>    LocalFsStorage rooted at the path.
  memory://<bucket>          MemoryStorage; test-only.

Cursor grammar (--from-snapshot):
  <currentJsonKey>@<etag>    Manifest-pointer cursor.
                             <currentJsonKey> = bucket-relative key
                             of the source collection's current.json.
                             <etag> = its ETag at cursor mint time;
                             copy refuses if source has advanced.

Exit codes:
  0  success
  1  user error (bad args / URI / cursor)
  2  storage error (network, auth, missing file)
  3  protocol invariant (corrupted snapshot, hash mismatch, source
     advanced past cursor)

See docs/pricing-log.md for the running log of price and cap changes.
`;

const main = async (argv: readonly string[]): Promise<number> => {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === "copy") return runCopy(argv.slice(1));
  process.stderr.write(`baerly: unknown subcommand ${JSON.stringify(argv[0])}\n${HELP}`);
  return 1;
};

main(process.argv.slice(2)).then(
  (c) => {
    process.exit(c);
  },
  (e: unknown) => {
    process.stderr.write(`baerly: ${(e as Error).message}\n`);
    process.exit(2);
  },
);
