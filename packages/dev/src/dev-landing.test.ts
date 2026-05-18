import { describe, expect, it } from "vitest";
import { renderDevLanding } from "./dev-landing.ts";

describe("renderDevLanding", () => {
  it("renders the app name and ui url", () => {
    const html = renderDevLanding({
      app: "tickets",
      uiUrl: "http://localhost:5173",
    });
    expect(html).toContain("<code>tickets</code>");
    expect(html).toContain(`href="http://localhost:5173"`);
    expect(html).toContain(`href="/v1/healthz"`);
    expect(html).toContain(">tickets<");
  });

  it("escapes HTML in app and uiUrl", () => {
    const html = renderDevLanding({
      app: "a&b",
      uiUrl: `javascript:alert(1)"<`,
    });
    // Verbatim attack strings must not appear.
    expect(html).not.toContain(`alert(1)"<`);
    // Escaped forms must.
    expect(html).toContain("a&amp;b");
    expect(html).toContain("&quot;");
  });
});
