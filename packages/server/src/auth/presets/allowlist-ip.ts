import { BaerlyError, type Verifier, type VerifierResult } from "@baerly/protocol";

/**
 * Options for {@link allowlistIp}.
 *
 * - `cidrs` — CIDR ranges of allowed source IPs. IPv4 and IPv6 both
 *   supported. Empty → `InvalidConfig`.
 * - `tenantPrefix` — single-tenant pin, same as
 *   `SharedSecretOptions.tenantPrefix`.
 * - `header` — header to read the client IP from. Defaults to
 *   `"CF-Connecting-IP"` (CF Workers). Node behind a trusted
 *   proxy: `"X-Forwarded-For"` (the verifier reads the leftmost
 *   non-empty IP from the comma-separated list).
 *
 * **Trust caveat.** Headers are spoofable by clients that talk to
 * your origin directly. `allowlistIp` is only meaningful when
 * deployed behind a proxy/CDN that overwrites the configured
 * header. Composing with `sharedSecret` or `bearerJwt` is the
 * usual defense-in-depth shape — see {@link andAll}.
 */
export interface AllowlistIpOptions {
  readonly cidrs: readonly string[];
  readonly tenantPrefix: string;
  readonly header?: string;
}

const DEFAULT_HEADER = "CF-Connecting-IP";

/**
 * Build a `Verifier` that accepts requests whose source IP falls
 * inside one of the configured CIDR ranges.
 *
 * @throws BaerlyError code="InvalidConfig" — empty `cidrs`, malformed
 *   CIDR, empty `tenantPrefix`, `tenantPrefix` containing `/`.
 *
 * @example
 * ```ts
 * import { allowlistIp } from "baerly-storage/auth";
 * const verifier = allowlistIp({
 *   cidrs: ["10.0.0.0/8", "192.168.1.0/24"],
 *   tenantPrefix: "internal",
 *   header: "CF-Connecting-IP",
 * });
 * ```
 */
export const allowlistIp = (opts: AllowlistIpOptions): Verifier => {
  if (opts.cidrs.length === 0) {
    throw new BaerlyError("InvalidConfig", "allowlistIp: cidrs must be non-empty");
  }
  if (opts.tenantPrefix.length === 0 || opts.tenantPrefix.includes("/")) {
    throw new BaerlyError(
      "InvalidConfig",
      `allowlistIp: tenantPrefix must be non-empty and "/"-free (got ${JSON.stringify(
        opts.tenantPrefix,
      )})`,
    );
  }
  const parsed: ParsedCidr[] = opts.cidrs.map((c) => {
    const p = parseCidr(c);
    if (p === null) {
      throw new BaerlyError("InvalidConfig", `allowlistIp: malformed CIDR ${JSON.stringify(c)}`);
    }
    return p;
  });
  const header = opts.header ?? DEFAULT_HEADER;

  return async (req: Request) => {
    const raw = req.headers.get(header);
    if (raw === null) {
      return null;
    }
    // `X-Forwarded-For` is a comma-separated chain; the leftmost
    // non-empty entry is the original client. CF-Connecting-IP is a
    // single value but the same parsing is safe.
    const ip = raw.split(",")[0]?.trim();
    if (ip === undefined || ip.length === 0) {
      return null;
    }
    const addr = parseAddress(ip);
    if (addr === null) {
      return null;
    }
    for (const cidr of parsed) {
      if (matchesCidr(addr, cidr)) {
        return { tenantPrefix: opts.tenantPrefix, identity: { kind: "ip", ip } };
      }
    }
    return null;
  };
};

/**
 * Compose two or more `Verifier`s with AND semantics: every verifier
 * must accept; the last verifier's `VerifierResult` is returned.
 * Use for defense-in-depth like "must be on the VPN AND have a valid
 * JWT":
 *
 * ```ts
 * const verifier = andAll(
 *   allowlistIp({ cidrs: ["10.0.0.0/8"], tenantPrefix: "_" }),
 *   bearerJwt({ ... }),
 * );
 * ```
 *
 * Earlier verifiers' `tenantPrefix` is discarded — the last one wins.
 * Configure non-final verifiers with a sentinel `tenantPrefix` like
 * `"_"` to make this explicit at the call site.
 *
 * @throws BaerlyError code="InvalidConfig" — zero verifiers passed.
 */
export const andAll = (...verifiers: readonly Verifier[]): Verifier => {
  if (verifiers.length === 0) {
    throw new BaerlyError("InvalidConfig", "andAll: must compose at least one Verifier");
  }
  return async (req: Request) => {
    let last: VerifierResult | null = null;
    for (const v of verifiers) {
      last = await v(req);
      if (last === null) {
        return null;
      }
    }
    return last;
  };
};

// ---------------------------------------------------------------- CIDR parser

/**
 * Internal representation of a parsed CIDR: the network address as a
 * fixed-width byte array (4 bytes for IPv4, 16 for IPv6) plus the
 * prefix length in bits.
 */
interface ParsedCidr {
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

const parseCidr = (s: string): ParsedCidr | null => {
  const slash = s.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const addrPart = s.slice(0, slash);
  const prefixPart = s.slice(slash + 1);
  const bits = Number.parseInt(prefixPart, 10);
  if (!Number.isInteger(bits) || bits < 0) {
    return null;
  }
  const addr = parseAddress(addrPart);
  if (addr === null) {
    return null;
  }
  const maxBits = addr.length * 8;
  if (bits > maxBits) {
    return null;
  }
  return { bytes: addr, prefixBits: bits };
};

/**
 * Parse an IPv4 or IPv6 address into bytes. Returns `null` on any
 * malformed input. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is recognized
 * and normalized to the 16-byte IPv6 form so the caller's CIDR table
 * doesn't have to enumerate both shapes — `matchesCidr` only checks
 * equal-family pairs, so callers configure CIDRs in whichever family
 * matches their proxy's emitted shape.
 */
const parseAddress = (s: string): Uint8Array | null => {
  if (s.includes(":")) {
    return parseIpv6(s);
  }
  return parseIpv4(s);
};

const parseIpv4 = (s: string): Uint8Array | null => {
  const parts = s.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (p.length === 0 || p.length > 3) {
      return null;
    }
    if (!/^\d+$/.test(p)) {
      return null;
    }
    const n = Number(p);
    if (n > 255) {
      return null;
    }
    out[i] = n;
  }
  return out;
};

const parseIpv6 = (s: string): Uint8Array | null => {
  // Handle "::" zero-run shorthand, including embedded IPv4
  // (`::ffff:1.2.3.4`). RFC 4291 §2.2.
  let lower = s.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) {
    lower = lower.slice(1, -1);
  }
  // Embedded IPv4 tail.
  let tail4: Uint8Array | null = null;
  const lastColon = lower.lastIndexOf(":");
  if (lastColon >= 0 && lower.slice(lastColon + 1).includes(".")) {
    tail4 = parseIpv4(lower.slice(lastColon + 1));
    if (tail4 === null) {
      return null;
    }
    lower = lower.slice(0, lastColon);
  }

  const doubleColon = lower.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    head = lower
      .slice(0, doubleColon)
      .split(":")
      .filter((p) => p.length > 0);
    tail = lower
      .slice(doubleColon + 2)
      .split(":")
      .filter((p) => p.length > 0);
  } else {
    head = lower.split(":");
    tail = [];
  }
  const totalGroups = head.length + tail.length + (tail4 !== null ? 2 : 0);
  if (totalGroups > 8) {
    return null;
  }
  if (doubleColon < 0 && totalGroups !== 8) {
    return null;
  }

  const groups: number[] = [];
  for (const part of head) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  const zerosToFill = 8 - totalGroups;
  if (doubleColon >= 0) {
    for (let i = 0; i < zerosToFill; i++) {
      groups.push(0);
    }
  }
  for (const part of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  if (tail4 !== null) {
    groups.push((tail4[0]! << 8) | tail4[1]!);
    groups.push((tail4[2]! << 8) | tail4[3]!);
  }
  if (groups.length !== 8) {
    return null;
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i]! >>> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
};

const matchesCidr = (addr: Uint8Array, cidr: ParsedCidr): boolean => {
  // Different address families never match. Callers configuring both
  // IPv4 and IPv6 ranges add separate entries.
  if (addr.length !== cidr.bytes.length) {
    return false;
  }
  const fullBytes = cidr.prefixBits >> 3;
  const remainingBits = cidr.prefixBits & 7;
  for (let i = 0; i < fullBytes; i++) {
    if (addr[i]! !== cidr.bytes[i]!) {
      return false;
    }
  }
  if (remainingBits === 0) {
    return true;
  }
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (addr[fullBytes]! & mask) === (cidr.bytes[fullBytes]! & mask);
};
