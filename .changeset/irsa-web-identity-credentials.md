---
'@gusto/baerly-storage': minor
---

Add IRSA (web-identity) credential support for S3 on EKS. `fromEksPodIdentity()`
only handled the EKS Pod Identity agent (`AWS_CONTAINER_CREDENTIALS_FULL_URI`);
clusters that inject credentials via IRSA (`AWS_ROLE_ARN` +
`AWS_WEB_IDENTITY_TOKEN_FILE`) threw `InvalidConfig` on first sign, so every S3
call failed.

Two new credential providers in `@gusto/baerly-storage/node`:

- `fromWebIdentity()` — exchanges the projected service-account token for
  short-lived credentials via STS `AssumeRoleWithWebIdentity` (an unsigned call;
  the token is the auth). Returns `expiration`, so the signing layer rotates the
  ~1h credentials automatically. No AWS SDK dependency — uses `fetch` plus the
  existing hardened XML parser.
- `fromEks()` — auto-detects the mechanism per resolve (Pod Identity when
  `AWS_CONTAINER_CREDENTIALS_FULL_URI` is present, otherwise IRSA), with a clear
  `InvalidConfig` error when neither is configured. Prefer this over the
  mechanism-specific providers unless you have a reason to pin one.

Both EKS providers now fail with actionable errors instead of a bare status: a
missing/unreadable or empty projected token throws `InvalidConfig`, and a failed
STS `AssumeRoleWithWebIdentity` call folds the STS error `Code`/`Message` (e.g.
`InvalidIdentityToken`) into the thrown message so credential misconfigs are
diagnosable at a glance.

`fromEksPodIdentity()` keeps its behavior; it only gains the same
`InvalidConfig` token-file guards.
