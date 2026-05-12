// HEALTHCHECK script. Called by Docker against the container's
// running process. Exits 0 on liveness, 1 on failure. Pure Node
// (no deps); distroless can't run a shell.
import { request } from "node:http";

const req = request(
  { host: "127.0.0.1", port: process.env.PORT ?? 8080, path: "/v1/healthz" },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1),
);
req.on("error", () => process.exit(1));
req.setTimeout(2000, () => {
  req.destroy();
  process.exit(1);
});
req.end();
