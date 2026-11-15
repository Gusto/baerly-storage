/**
 * `baerly doctor --bucket <uri>` — live LIST key-encoding probe.
 *
 * App, tenant, and collection names may hold `%`, spaces, `+`, and
 * XML-special characters, and they are interpolated raw into object keys.
 * The S3 and GCS adapters list with `encoding-type=url` and decode each
 * returned key once; GC then deletes the keys LIST hands back. A backend
 * or gateway that ignores `encoding-type=url`, encodes twice, or encodes
 * `+` / spaces differently hands back keys that are not the ones written,
 * so this probe writes keys with those characters, lists them, and
 * compares the listed key byte-for-byte against what was put.
 *
 * Bounded: two puts, two single-prefix lists (at most
 * {@link LIST_ENTRY_LIMIT} entries each), and two deletes, all under a
 * fresh `__baerly_list_probe__/<uuid>/` prefix. Cleanup runs in `finally`
 * and a failed delete is reported, not swallowed.
 */

import { BaerlyError, type Storage, uuid } from "@baerly/protocol";
import { type DoctorFinding, type DoctorReport, rollupStatus } from "./cloudflare.ts";

/**
 * The two sentinel key leaves. `escapes` carries already-valid percent
 * escapes (`%2F`, `%25`), whitespace, `+`, the five XML-special
 * characters, and a non-ASCII letter; it decodes cleanly, so a key that
 * was decoded one time too many is recognisable. `bare-percent` carries
 * a `%` that starts no valid escape, which a raw (unencoded) LIST
 * response cannot decode at all.
 */
export const LIST_PROBE_SENTINELS = [
  { name: "escapes", leaf: `e/a%2Fb %25 c+d & < > " ' é` },
  { name: "bare-percent", leaf: "p/100% bare" },
] as const;

/** Per-list entry cap. Only one object lives under each listed prefix. */
export const LIST_ENTRY_LIMIT = 8;

const utf8 = new TextEncoder();

const LIST_FIX =
  "Point baerly at a store whose ListObjects honours `encoding-type=url` and returns each key " +
  "exactly as written (AWS S3, Cloudflare R2, MinIO, and native GCS do). A gateway or proxy " +
  "that rewrites list responses can break this; names holding `%`, spaces, `+`, or `&<>\"'` " +
  "would otherwise be mis-listed and mishandled by maintenance.";

/** The adapters' decode step: `+` → space, then one percent-decode. */
const decodeOnce = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
};

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const firstByteDiff = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return n;
};

const sameBytes = (a: string, b: string): boolean => {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  return x.length === y.length && firstByteDiff(x, y) === x.length;
};

/**
 * Known ways a listed key goes wrong, checked in order. Each derives the
 * expected-wrong listing from the put key and names the likely cause.
 */
const DIAGNOSES: ReadonlyArray<{
  readonly kind: string;
  readonly matches: (listed: string, put: string) => boolean;
  readonly cause: string;
}> = [
  {
    kind: "not decoded",
    matches: (listed, put) => decodeOnce(listed) === put,
    cause:
      "it still carries one layer of URL encoding: the backend encodes list keys twice, or the client does not decode `encoding-type=url` responses",
  },
  {
    kind: "double decoded",
    matches: (listed, put) => {
      const once = decodeOnce(put);
      return once !== undefined && once !== put && listed === once;
    },
    cause:
      "it was decoded one time too many: the backend ignores `encoding-type=url` and returns raw keys, or the client decodes twice",
  },
  {
    kind: "`+` not decoded to space",
    matches: (listed, put) => put.includes(" ") && listed === put.replaceAll(" ", "+"),
    cause:
      "spaces came back as `+`: the encoded form uses `+` for space and the client percent-decodes without mapping `+` back",
  },
  {
    kind: "literal `+` decoded to space",
    matches: (listed, put) => put.includes("+") && listed === put.replaceAll("+", " "),
    cause:
      "a literal `+` came back as a space: the backend does not percent-encode `+` in list keys",
  },
  {
    kind: "XML entities not unescaped",
    matches: (listed, put) => listed === xmlEscape(put),
    cause:
      "XML entities such as `&amp;` were left in the key: the list response was not XML-unescaped",
  },
];

const describeMismatch = (listed: string, put: string, show: (k: string) => string): string => {
  const diagnosis = DIAGNOSES.find((d) => d.matches(listed, put));
  const got = `expected ${show(put)}, got ${show(listed)}`;
  if (diagnosis !== undefined) {
    return `${diagnosis.kind} — ${got}; ${diagnosis.cause}.`;
  }
  const offset = firstByteDiff(utf8.encode(put), utf8.encode(listed));
  return `wrong decoding — ${got}; first differing UTF-8 byte at offset ${offset}.`;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Write each sentinel, list it back under its own prefix, compare the
 * listed key byte-for-byte, and delete it. Status is `error` iff a
 * sentinel was not listed exactly as written; a failed cleanup delete is
 * a `warning` naming the leaked key.
 */
export const doctorListEncoding = async (
  storage: Storage,
  keyPrefix: string,
): Promise<DoctorReport> => {
  const root = `${keyPrefix}__baerly_list_probe__/${uuid()}/`;
  const show = (k: string): string => JSON.stringify(k.startsWith(root) ? k.slice(root.length) : k);
  const findings: DoctorFinding[] = [];
  const written: string[] = [];
  try {
    for (const sentinel of LIST_PROBE_SENTINELS) {
      const check = `list-encoding-${sentinel.name}`;
      const key = `${root}${sentinel.leaf}`;
      const fail = (message: string): void => {
        findings.push({ severity: "error", check, message, fix: LIST_FIX });
      };
      try {
        written.push(key);
        await storage.put(key, utf8.encode(sentinel.name));
      } catch (error) {
        fail(`PUT of the ${show(key)} sentinel failed: ${errorText(error)}`);
        continue;
      }
      const listed: string[] = [];
      try {
        const prefix = `${root}${sentinel.leaf.slice(0, sentinel.leaf.indexOf("/") + 1)}`;
        for await (const entry of storage.list(prefix, { maxKeys: LIST_ENTRY_LIMIT })) {
          listed.push(entry.key);
          if (listed.length >= LIST_ENTRY_LIMIT) {
            break;
          }
        }
      } catch (error) {
        const hint =
          error instanceof BaerlyError && error.code === "InvalidResponse"
            ? " The listed key is not valid URL encoding: the backend likely ignores `encoding-type=url` and returns raw keys."
            : "";
        fail(`LIST after writing ${show(key)} failed: ${errorText(error)}.${hint}`);
        continue;
      }
      if (listed.some((k) => sameBytes(k, key))) {
        findings.push({
          severity: "ok",
          check,
          message: `LIST returned the ${show(key)} sentinel byte-for-byte as written.`,
        });
      } else if (listed.length === 0) {
        fail(
          `LIST did not return the ${show(key)} sentinel just written (no keys under its prefix).`,
        );
      } else {
        fail(`LIST mis-encoded the sentinel key: ${describeMismatch(listed[0]!, key, show)}`);
      }
    }
  } finally {
    for (const key of written) {
      try {
        await storage.delete(key);
      } catch (error) {
        findings.push({
          severity: "warning",
          check: "list-encoding-cleanup",
          message: `Could not delete probe sentinel ${JSON.stringify(key)}: ${errorText(error)}`,
          fix: "Delete that object by hand; it is not read by baerly.",
        });
      }
    }
  }
  return { findings, status: rollupStatus(findings) };
};
