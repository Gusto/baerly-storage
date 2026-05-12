/**
 * Worker entry for {{appName}}. Wires `@baerly/adapter-cloudflare`
 * to the bound R2 bucket and the Verifier of your choice.
 *
 * The emitted default uses `sharedSecret()` from `@baerly/server`
 * for parity with `wrangler dev`. Production: swap to
 * `cloudflareAccess()` from `@baerly/server` and wire CF Access
 * in front of the Worker route. See ticket 39's deploy template
 * for the production-shaped variant.
 */
import { baerlyWorker, type Env as BaerlyEnv } from "@baerly/adapter-cloudflare";
import { sharedSecret } from "@baerly/server";

interface AppEnv extends BaerlyEnv {
  readonly SHARED_SECRET: string;
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const handler = baerlyWorker({
      verifier: sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "{{tenant}}" }),
    });
    return handler.fetch!(req, env, ctx);
  },
  async scheduled(event, env, ctx): Promise<void> {
    const handler = baerlyWorker({
      verifier: sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "{{tenant}}" }),
    });
    return handler.scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
