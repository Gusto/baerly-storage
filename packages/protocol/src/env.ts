// Deployment detection shared by the in-memory storage guard and the
// Node resolveStorageFromEnv resolver. Pure (env passed in) so it stays
// Workerd-loadable. Markers are vars each platform sets unconditionally:
// Cloud Run, Heroku, Kubernetes, ECS, Railway, Render, Fly.
//
// The list is deliberately conservative: every marker here is set ONLY by
// the platform at runtime, never by that platform's local dev emulator, so
// detection cannot false-positive a developer's machine. Serverless markers
// like VERCEL / NETLIFY / AWS_LAMBDA_FUNCTION_NAME are intentionally omitted
// — their local emulators (`vercel dev`, `netlify dev`, SAM local) set the
// same vars, so adding them would break local development. Before adding a
// marker, confirm it is never set by that platform's dev tooling. An
// unmarked host should set NODE_ENV=production to opt into the guard.
export const PAAS_MARKERS = [
  "RAILWAY_ENVIRONMENT",
  "RENDER",
  "FLY_APP_NAME",
  "K_SERVICE",
  "DYNO",
  "KUBERNETES_SERVICE_HOST",
  "ECS_CONTAINER_METADATA_URI_V4",
] as const;

/**
 * True when `env` looks like a deployed environment: `NODE_ENV=production`
 * or any {@link PAAS_MARKERS} set to a non-empty value. Decides whether a
 * non-durable store (in-memory, local-fs) should fail loud instead of
 * silently serving a production workload. A CI runner (`CI` set to a
 * non-empty, non-`false` value) is never treated as deployed, so PaaS
 * markers from an in-cluster CI agent do not trip it.
 */
export const isDeployedEnv = (env: Record<string, string | undefined>): boolean => {
  // A CI runner is never a deployment — even in a k8s pod that sets a PaaS
  // marker (e.g. KUBERNETES_SERVICE_HOST) — so it must not trip the markers.
  const inCi = (env["CI"] ?? "") !== "" && env["CI"] !== "false";
  return (
    env["NODE_ENV"] === "production" || (!inCi && PAAS_MARKERS.some((m) => (env[m] ?? "") !== ""))
  );
};
