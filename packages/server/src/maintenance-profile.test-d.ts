/**
 * Compile-time drift guard for the two MaintenanceProfile definitions.
 *
 * The named profile constants are typed in `@baerly/protocol`
 * (`MaintenanceProfileShape`) to avoid a server→protocol import cycle, while
 * the canonical interface `MaintenanceProfile` lives in `./maintenance.ts`.
 * Plain structural assignability only catches one drift direction; `Equal`
 * is EXACT, so a renamed, added, removed, or retyped field on EITHER side
 * fails `tsgo --noEmit`. This `.test-d.ts` is typechecked but never bundled,
 * so the guard costs zero bundle bytes — the "keep field-identical" comments
 * on both definitions now name a mechanism that is actually enforced.
 */
import type { MaintenanceProfile } from "./maintenance.ts";
import type { MAINTENANCE_PROFILE_CF_FREE } from "@baerly/protocol";

// `Equal<X, Y>` forces strict equality (not mere bidirectional assignability)
// — the same idiom used in `config.test-d.ts`.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type _MaintenanceProfileShapeInSync = Expect<
  Equal<MaintenanceProfile, typeof MAINTENANCE_PROFILE_CF_FREE>
>;
