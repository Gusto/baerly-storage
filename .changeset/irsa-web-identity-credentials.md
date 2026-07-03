---
"@gusto/baerly-storage": minor
---

Add IRSA (web-identity) credential support for S3 on EKS. Previously
`fromEksPodIdentity()` handled only the EKS Pod Identity agent
(`AWS_CONTAINER_CREDENTIALS_FULL_URI`). Clusters that inject credentials via
IRSA (`AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`) threw `InvalidConfig` on
first sign, so every S3 call failed.

Two new credential providers in `@gusto/baerly-storage/node`:

- `fromWebIdentity()` — exchanges the projected service-account token for
  short-lived credentials via STS `AssumeRoleWithWebIdentity`. The call is
  unsigned; the token is the auth. It returns `expiration`, so the signing layer
  rotates the ~1h credentials automatically. No AWS SDK dependency — it uses
  `fetch` plus the existing hardened XML parser.
- `fromEks()` — auto-detects the mechanism on each resolve: Pod Identity when
  `AWS_CONTAINER_CREDENTIALS_FULL_URI` is present, otherwise IRSA. It throws a
  clear `InvalidConfig` when neither is configured. Prefer this over the
  mechanism-specific providers unless you have a reason to pin one.

Both EKS providers now fail with actionable errors instead of a bare status. A
missing, unreadable, or empty projected token throws `InvalidConfig`. A failed
STS `AssumeRoleWithWebIdentity` call folds the STS error `Code`/`Message` (for
example, `InvalidIdentityToken`) into the thrown message, so credential
misconfigs are diagnosable at a glance.

`fromEksPodIdentity()` keeps its behavior; it only gains the same
`InvalidConfig` token-file guards.
