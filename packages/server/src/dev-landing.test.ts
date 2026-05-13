import { describe, expect, it } from "vitest";
import { renderDevLanding } from "./dev-landing.ts";

describe("renderDevLanding", () => {
  it("renders the app label, app name, and ui url", () => {
    const html = renderDevLanding({
      app: "tickets",
      uiUrl: "http://localhost:5173",
      appLabel: "Helpdesk demo",
    });
    expect(html).toContain("Helpdesk demo");
    expect(html).toContain("<code>tickets</code>");
    expect(html).toContain(`href="http://localhost:5173"`);
    expect(html).toContain(`href="/v1/healthz"`);
  });

  it("falls back to app when appLabel is omitted", () => {
    const html = renderDevLanding({ app: "tickets", uiUrl: "http://localhost:5173" });
    expect(html).toContain(">tickets<");
  });

  it("escapes HTML in app, uiUrl, and appLabel", () => {
    const html = renderDevLanding({
      app: "a&b",
      uiUrl: `javascript:alert(1)"<`,
      appLabel: "<script>evil()</script>",
    });
    // Verbatim attack strings must not appear.
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).not.toContain(`alert(1)"<`);
    // Escaped forms must.
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).toContain("&quot;");
  });
});
