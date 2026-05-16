import type { IncomingMessage, ServerResponse } from "node:http";
import { createColors } from "picocolors";

export interface RequestLoggerOpts {
  readonly ignore?: ReadonlyArray<RegExp>;
  readonly label?: string;
  readonly quiet?: boolean;
  readonly plain?: boolean;
  readonly write?: (chunk: string) => void;
  readonly clock?: () => bigint;
}

const DEFAULT_IGNORE = [/\/since/];

const truncatePath = (path: string, width: number): string => {
  if (path.length <= width) return path.padEnd(width);
  return path.slice(0, width - 1) + "…";
};

export function withRequestLogging<
  H extends (req: IncomingMessage, res: ServerResponse) => unknown,
>(handler: H, opts?: RequestLoggerOpts): H {
  if (opts?.quiet === true) return handler;

  const ignore = opts?.ignore ?? DEFAULT_IGNORE;
  const label = opts?.label ?? "";
  const plain =
    opts?.plain !== undefined
      ? opts.plain
      : process.env["CI"] !== undefined || !process.stderr.isTTY;
  const write = opts?.write ?? ((chunk) => process.stderr.write(chunk));
  const clock = opts?.clock ?? (() => process.hrtime.bigint());
  const pc = createColors(!plain);

  const methodColor = (method: string): string => {
    if (plain) return method.padEnd(6);
    switch (method) {
      case "POST":
      case "PATCH":
        return pc.magenta(method.padEnd(6));
      case "DELETE":
        return pc.red(method.padEnd(6));
      case "GET":
      case "HEAD":
      case "OPTIONS":
        return pc.dim(method.padEnd(6));
      default:
        return method.padEnd(6);
    }
  };

  const statusColor = (status: number): string => {
    const s = String(status);
    if (plain) return s;
    if (status >= 200 && status < 300) return pc.dim(s);
    if (status >= 300 && status < 400) return pc.cyan(s);
    if (status >= 400 && status < 500) return pc.yellow(s);
    if (status >= 500) return pc.red(s);
    return s;
  };

  return function (req: IncomingMessage, res: ServerResponse) {
    const start = clock();
    let emitted = false;

    const emit = () => {
      if (emitted) return;
      emitted = true;

      const url = req.url ?? "/";
      for (const re of ignore) {
        if (re.test(url)) return;
      }

      const elapsed = Number((clock() - start) / 1_000_000n);
      const method = req.method ?? "GET";
      const status = res.statusCode;

      const methodStr = methodColor(method);
      const pathStr = truncatePath(url, 50);
      const statusStr = statusColor(status);
      const msVal = String(elapsed).padStart(4);
      const msSuffix = plain ? "ms" : pc.dim("ms");

      const prefix = label ? `${label} ` : "";
      write(`${prefix}${methodStr}  ${pathStr}  ${statusStr}  ${msVal}${msSuffix}\n`);
    };

    res.on("finish", emit);
    res.on("close", emit);

    return handler(req, res);
  } as H;
}
