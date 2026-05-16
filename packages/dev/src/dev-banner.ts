import { createColors } from "picocolors";

export interface DevBannerHint {
  readonly key: string;
  readonly value: string;
}

export interface DevBannerOpts {
  readonly name: string;
  readonly primaryUrl?: { readonly label: string; readonly url: string };
  readonly apiUrl?: { readonly label: string; readonly url: string; readonly note?: string };
  readonly hints?: ReadonlyArray<DevBannerHint>;
  /** Force plain-text output (no color, no `←`). Defaults to !isTTY || CI. */
  readonly plain?: boolean;
  /** Sink. Defaults to process.stderr. */
  readonly write?: (chunk: string) => void;
}

export function printDevBanner(opts: DevBannerOpts): void {
  const isPlain =
    opts.plain !== undefined
      ? opts.plain
      : process.env["CI"] !== undefined || !process.stderr.isTTY;
  const write = opts.write ?? ((chunk) => process.stderr.write(chunk));
  const pc = createColors(!isPlain);

  const lines: string[] = [];

  if (isPlain) {
    lines.push(`baerly · ${opts.name}`);

    if (opts.primaryUrl) {
      lines.push(`${opts.primaryUrl.label}: ${opts.primaryUrl.url}`);
    }
    if (opts.apiUrl) {
      const note = opts.apiUrl.note ? ` (${opts.apiUrl.note})` : "";
      lines.push(`${opts.apiUrl.label}: ${opts.apiUrl.url}${note}`);
    }
    if (opts.hints && opts.hints.length > 0) {
      for (const hint of opts.hints) {
        lines.push(`${hint.key}: ${hint.value}`);
      }
    }
    write(lines.join("\n") + "\n");
  } else {
    lines.push(pc.bold(pc.cyan(`▎ baerly · ${opts.name}`)));
    lines.push("");

    if (opts.primaryUrl) {
      const marker = ` ${pc.green("← open this")}`;
      lines.push(`  ${pc.dim(opts.primaryUrl.label)}  →  ${opts.primaryUrl.url}${marker}`);
    }
    if (opts.apiUrl) {
      const note = opts.apiUrl.note ? `  ${pc.dim(`(${opts.apiUrl.note})`)}` : "";
      lines.push(`  ${pc.dim(opts.apiUrl.label)}  →  ${opts.apiUrl.url}${note}`);
    }
    if ((opts.primaryUrl || opts.apiUrl) && opts.hints && opts.hints.length > 0) {
      lines.push("");
    }
    if (opts.hints && opts.hints.length > 0) {
      const maxKeyLen = Math.max(...opts.hints.map((h) => h.key.length));
      for (const hint of opts.hints) {
        lines.push(`  ${pc.dim(hint.key.padEnd(maxKeyLen))}  ${hint.value}`);
      }
    }
    lines.push("");
    write(lines.join("\n"));
  }
}
