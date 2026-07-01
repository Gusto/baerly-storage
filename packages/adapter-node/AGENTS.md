## When NOT to use this package

On Cloudflare Workers, do NOT use `@baerly/adapter-node`'s S3-credentials
factory — use `r2BindingStorage` from `@gusto/baerly-storage/cloudflare`
(the native R2 binding). This package is for Node hosts that talk to an
S3-compatible endpoint over HTTP.

## Credentials

All four storage factories (`s3Storage`, `r2Storage`, `minioStorage`,
`gcsStorage`) take a single `credentials` field. The shape matches
`@smithy/types`' `AwsCredentialIdentity` so `@aws-sdk/credential-providers`
output works as-is.

### Static credentials

```ts
import { s3Storage } from "@gusto/baerly-storage/node";

const storage = s3Storage({
  region: "us-east-1",
  bucket: process.env.BUCKET!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
```

### EKS — `fromEks()` (recommended)

For EKS deployments, use `fromEks()`. It auto-detects which credential
mechanism the cluster injects — **EKS Pod Identity** (2023+) or **IRSA**
(web-identity token) — so you don't have to know which one is in play:

```ts
import { s3Storage, fromEks } from "@gusto/baerly-storage/node";

const storage = s3Storage({
  region: process.env.AWS_REGION!,
  bucket: process.env.BUCKET!,
  credentials: fromEks(),
});
```

Detection runs per resolve (Pod Identity preferred when both env sets are
present); it throws `InvalidConfig` when neither is configured.

### Pinning a mechanism — `fromEksPodIdentity()` / `fromWebIdentity()`

Use these directly only if you need to pin one mechanism:

- **`fromEksPodIdentity()`** — EKS Pod Identity agent. Reads
  `AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`,
  GETs the node-local agent at `169.254.170.23`, returns short-lived creds.
- **`fromWebIdentity()`** — IRSA. Reads `AWS_ROLE_ARN` +
  `AWS_WEB_IDENTITY_TOKEN_FILE`, exchanges the projected SA token via STS
  `AssumeRoleWithWebIdentity` (unsigned — the token is the auth), returns
  short-lived creds. Honors `AWS_ROLE_SESSION_NAME` and `AWS_REGION` /
  `AWS_DEFAULT_REGION` (regional STS endpoint; falls back to global).

All three report `expiration`, so refresh is automatic: the signer caches
credentials until 5 minutes before `expiration`, then calls the provider
again. Concurrent refreshes are single-flighted.

### Bring your own provider

`credentials` accepts any `() => Promise<{accessKeyId, secretAccessKey, sessionToken?, expiration?}>`.
That's the whole contract — write whatever you need:

```ts
import { s3Storage, type CredentialsProvider } from "@gusto/baerly-storage/node";

const myProvider: CredentialsProvider = async () => {
  // …fetch from your secrets store, parse, return shape…
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
};

s3Storage({ region, bucket, credentials: myProvider });
```

### Interop with `@aws-sdk/credential-providers`

The `credentials` field accepts any `() => Promise<AwsCredentialIdentity>`,
so AWS SDK providers pass through unchanged — useful for ECS task
roles, EC2 IMDSv2, env-var resolution, SSO, or `~/.aws/config`
parsing (none of which baerly-storage ships natively):

```ts
import { fromContainerMetadata } from "@aws-sdk/credential-providers";
import { s3Storage } from "@gusto/baerly-storage/node";

s3Storage({ region, bucket, credentials: fromContainerMetadata() });
```

Pay the ~14 MB of `@aws-sdk/*` only when you need it.
