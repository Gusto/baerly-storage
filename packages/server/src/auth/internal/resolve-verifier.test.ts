import {
  type BaerlyAppConfig,
  BaerlyError,
  NO_AUTH_CONFIGURED_MESSAGE,
  SHARED_SECRET_MISSING_MESSAGE,
  type Verifier,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { resolveVerifier } from "./resolve-verifier.ts";

const baseConfig = (auth: BaerlyAppConfig["auth"]): BaerlyAppConfig => ({
  app: "t-app",
  tenant: "t-tenant",
  target: "cloudflare",
  auth,
  collections: {},
});

describe("resolveVerifier", () => {
  test("factoryVerifier overrides everything", async () => {
    const override: Verifier = async () => ({
      tenantPrefix: "from-override",
      identity: { kind: "test" },
    });
    const v = resolveVerifier({
      factoryVerifier: override,
      config: baseConfig("none"),
      readEnv: () => "ignored",
    });
    const r = await v(new Request("http://x/"));
    expect(r?.tenantPrefix).toBe("from-override");
  });

  test('auth: "shared-secret" + SHARED_SECRET present → sharedSecret verifier pinned to config.tenant', async () => {
    const v = resolveVerifier({
      factoryVerifier: undefined,
      config: baseConfig("shared-secret"),
      readEnv: (k) => (k === "SHARED_SECRET" ? "topsecret" : undefined),
    });
    const ok = await v(
      new Request("http://x/", { headers: { authorization: "Bearer topsecret" } }),
    );
    expect(ok?.tenantPrefix).toBe("t-tenant");
    const bad = await v(new Request("http://x/"));
    expect(bad).toBeNull();
  });

  test('auth: "shared-secret" + SHARED_SECRET unset → InvalidConfig with locked message', () => {
    expect(() =>
      resolveVerifier({
        factoryVerifier: undefined,
        config: baseConfig("shared-secret"),
        readEnv: () => undefined,
      }),
    ).toThrow(SHARED_SECRET_MISSING_MESSAGE);
  });

  test('auth: "shared-secret" + SHARED_SECRET empty string → InvalidConfig (treats empty as unset)', () => {
    expect(() =>
      resolveVerifier({
        factoryVerifier: undefined,
        config: baseConfig("shared-secret"),
        readEnv: () => "",
      }),
    ).toThrow(SHARED_SECRET_MISSING_MESSAGE);
  });

  test('auth: "none" → pins every request to config.tenant, identity.kind === "none"', async () => {
    const v = resolveVerifier({
      factoryVerifier: undefined,
      config: baseConfig("none"),
      readEnv: () => undefined,
    });
    const r = await v(new Request("http://x/"));
    expect(r).toEqual({ tenantPrefix: "t-tenant", identity: { kind: "none" } });
    // No Authorization header required.
    const r2 = await v(new Request("http://x/", { headers: { authorization: "Bearer anything" } }));
    expect(r2?.tenantPrefix).toBe("t-tenant");
  });

  test("InvalidConfig errors carry the BaerlyError code discriminant", () => {
    let caught: unknown;
    try {
      resolveVerifier({
        factoryVerifier: undefined,
        config: baseConfig("shared-secret"),
        readEnv: () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BaerlyError);
    expect((caught as BaerlyError).code).toBe("InvalidConfig");
  });

  test("locked error wording is exactly the protocol constant", () => {
    expect(NO_AUTH_CONFIGURED_MESSAGE).toBe(
      'baerly: no auth configured. Set `auth` in baerly.config.ts ("none", "shared-secret") or pass `verifier` on the adapter factory.',
    );
    expect(SHARED_SECRET_MISSING_MESSAGE).toBe(
      'baerly: auth="shared-secret" but SHARED_SECRET env is empty/unset. Cloudflare: `wrangler secret put SHARED_SECRET`, or add to .dev.vars for local dev. Node: set in process env.',
    );
  });
});
