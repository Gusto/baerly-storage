# Cut the `--with=docker` scaffold add-on

**Severity: HIGH. Pre-launch cut. Distroless multi-stage Dockerfile
for a hello-world is textbook borrowed maturity; the README
itself admits Docker isn't on the happy path.**

The opt-in add-on layered on top of `--target=node`. Distroless
Node image, multi-stage build, non-root user, OCI labels,
node-script HEALTHCHECK.

- `/Users/eric.baer/workspace/baerly-storage/packages/create-baerly/templates/addons/docker/Dockerfile`
- `/Users/eric.baer/workspace/baerly-storage/packages/create-baerly/templates/addons/docker/healthcheck.js`
- `/Users/eric.baer/workspace/baerly-storage/packages/create-baerly/templates/addons/docker/.dockerignore`

## The case for cutting

The thesis audience (finance team, internal PM, weekend side
project, $20/mo ChatGPT subscriber) writes apps that "run anywhere
`node server.js` runs — Railway, Render, Fly **without Docker**,
Heroku." The "without Docker" hedge is in the README itself —
Docker is explicitly off the happy path.

Distroless containers + non-root users + OCI labels + node-script
HEALTHCHECK is *graduation-tier* operational ceremony attached to
a *prototype-tier* primitive. The audience that needs a
production-shaped container has already graduated to a system
(k8s, ECS, Fly Machines) where they'll write a Dockerfile
appropriate to their orchestration constraints.

Pre-launch is the window to not ship borrowed maturity (deferred
changes-iterator memo §5). Distroless / multi-stage / non-root /
OCI labels are all maturity-signaling artifacts that imply a
production-grade ops posture the system isn't actually ready to
honor at scale.

## What to do

1. Delete `packages/create-baerly/templates/addons/docker/`.
2. Drop the `--with=docker` flag handling from
   `packages/create-baerly/src/scaffold.ts` (or wherever add-on
   layering happens).
3. Drop the rolldown mirroring of `templates/addons/` to
   `dist/templates/addons/` (if cuts leave the addons dir empty,
   delete the mirroring step).
4. Audit docs/scaffold tests for any `--with=docker` reference.

## What gets harder after

- A user who graduates to k8s and wants a Dockerfile reference
  writes one in 30 minutes when they actually need one (the
  Dockerfile is well-documented public knowledge). **Acceptable.**
- The `baerly deploy` table loses the `--with=docker` column.
  **Net win** — fewer rows.

## Notes

If a real audience consumer ever asks for Docker post-launch
(unlikely), revisit. Until then, the addon is solving a problem
the audience doesn't have.

## Related cuts

- Part of the **scaffold weight** theme. Pairs with
  `cut-scaffold-minimal-variants.md`, `cut-scaffold-test-infra.md`,
  `collapse-scaffold-agents-md.md`, `cut-scaffold-wrangler-knobs.md`.
