/**
 * Dev landing page for the API root (`GET /`).
 *
 * The HTTP surface is API-only: every path outside `/v1/*`
 * returns the {@link HttpErrorEnvelope} 404 shape. That's correct for
 * production but confusing in local dev — a user who clicks the
 * `http://localhost:3000` link in their terminal sees a JSON 404 and
 * assumes the server is broken.
 *
 * Adapters that wire the {@link DevLandingOptions} opt-in surface a
 * small HTML page on `GET /` instead: app label, a clickable link to
 * the UI, a `/v1/healthz` probe link, and a note that `/v1/t/*` is
 * auth-gated. `GET /favicon.ico` answers 204 so browsers don't pin a
 * second JSON 404 next to the landing page.
 *
 * Production deployments leave the option unset; the 404 falls
 * through to the existing envelope.
 */

/** Options for {@link renderDevLanding}. */
export interface DevLandingOptions {
  /** Bucket-prefix / app name (typically passed through from the adapter's `app` option). */
  readonly app: string;
  /** URL of the human-facing UI (e.g., `"http://localhost:5173"`). */
  readonly uiUrl: string;
}

/**
 * Render the dev landing page HTML. Dependency-free; system fonts
 * only; no JS. All substitutions are HTML-escaped to keep the page
 * inert even when `app` / `uiUrl` come from env vars.
 */
export const renderDevLanding = (opts: DevLandingOptions): string => {
  const label = escapeHtml(opts.app);
  const app = escapeHtml(opts.app);
  const uiUrl = escapeHtml(opts.uiUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${label} — baerly api</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.5rem; color: #222; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  p.tag { color: #666; margin: 0 0 1.5rem; font-size: 0.9rem; }
  a { color: #06c; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.25rem 0; }
  code { background: #f3f3f3; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<h1>${label}</h1>
<p class="tag">baerly api server · app <code>${app}</code></p>
<p>This is the API server. The UI lives at <a href="${uiUrl}">${uiUrl}</a>.</p>
<ul>
  <li>Open the UI: <a href="${uiUrl}">${uiUrl}</a></li>
  <li>Health probe: <a href="/v1/healthz">/v1/healthz</a></li>
  <li>CRUD routes under <code>/v1/t/*</code> require an auth header and aren't clickable from here.</li>
</ul>
</body>
</html>
`;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
