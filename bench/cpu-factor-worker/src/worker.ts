/**
 * The deployed bench Worker. One request runs one cell: GET /?cell=<name>.
 * Every cell reports through the same path: an in-isolate timer (cross-check
 * only, deployed clocks advance only across I/O) and a `CPUFACTOR {...}` log
 * line; `cpuTime` from the platform is authoritative. Fixtures are
 * synthetic and injected at build time (`cpu-factor:fixtures`).
 */
import { CELL_BY_NAME, CELLS, type Cell } from "./cells.ts";
import { type Fixture, runInvocation, runSubject } from "./common.ts";
import { type ProbeEnv, runProbe } from "./probes.ts";
import { runTreeStep } from "./tree-step.ts";
// Resolved by build.ts (esbuild plugin) to the generated out/fixtures.json.
import fixtures from "cpu-factor:fixtures";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const run = async (cell: Cell, env: ProbeEnv | undefined): Promise<Record<string, unknown>> => {
  switch (cell.kind) {
    case "noop": {
      return { cold: false, folded: 0, written: false };
    }
    case "subject": {
      const fx = (fixtures as Record<string, Fixture>)[cell.fixture!]!;
      return await runSubject(fx, cell.mutations!);
    }
    case "tree": {
      return { ...(await runTreeStep(cell.tree!)) };
    }
    case "probe": {
      const result = await runProbe(cell.probe!, env);
      return { cold: false, probe: result };
    }
    case "fold": {
      const fx = (fixtures as Record<string, Fixture>)[cell.fixture!]!;
      return await runInvocation(fx, { part: cell.part!, entries: cell.entries! });
    }
  }
};

export default {
  async fetch(request: Request, env?: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("cell");
    const cell = name === null ? undefined : CELL_BY_NAME[name];
    if (cell === undefined) {
      return Response.json(
        { error: "unknown cell", cells: CELLS.map((c) => c.name) },
        { status: 400 },
      );
    }
    await tick();
    const t0 = performance.now();
    const result = await run(cell, env);
    await tick();
    const ms = performance.now() - t0;
    const line = { cell: cell.name, ms, ...result };
    console.log(`CPUFACTOR ${JSON.stringify(line)}`);
    return Response.json(line);
  },
};
