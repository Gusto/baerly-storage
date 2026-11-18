// Compatibility date and flags the `cloudflare-pool` project runs under.
// They come from the Cloudflare scaffolds' `wrangler.jsonc`, so the Workers
// gate exercises the runtime configuration users deploy and a scaffold date
// bump moves the test runtime with it.
import { readFileSync } from "node:fs";

interface WranglerCompat {
  readonly compatibilityDate: string;
  readonly compatibilityFlags: string[];
}

const SCAFFOLDS = ["minimal-cloudflare", "react-cloudflare"] as const;

/**
 * Strip `//` and `/* *\/` comments (outside string literals) and trailing
 * commas from JSONC text.
 */
export const stripJsonc = (text: string): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};

const readCompat = (scaffold: string): WranglerCompat => {
  const url = new URL(`../../examples/${scaffold}/wrangler.jsonc`, import.meta.url);
  const parsed = JSON.parse(stripJsonc(readFileSync(url, "utf8"))) as {
    compatibility_date: string;
    compatibility_flags?: string[];
  };
  return {
    compatibilityDate: parsed.compatibility_date,
    compatibilityFlags: [...(parsed.compatibility_flags ?? [])].toSorted(),
  };
};

export const scaffoldWranglerCompat = (): WranglerCompat => {
  const [first, ...rest] = SCAFFOLDS.map(readCompat);
  for (const other of rest) {
    if (JSON.stringify(other) !== JSON.stringify(first)) {
      throw new Error(
        `${SCAFFOLDS.join(" and ")} must declare the same compatibility_date and compatibility_flags in wrangler.jsonc`,
      );
    }
  }
  return first!;
};
