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

### EKS Pod Identity — `fromEksPodIdentity()`

For EKS deployments where the pod's service account is associated
with an IAM role via the EKS Pod Identity agent (2023+, the
successor to IRSA), use `fromEksPodIdentity()`. The provider reads
`AWS_CONTAINER_CREDENTIALS_FULL_URI` + `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`
(EKS injects both), GETs the node-local agent at
`169.254.170.23`, and returns short-lived credentials with
`expiration`.

```ts
import { s3Storage, fromEksPodIdentity } from "@gusto/baerly-storage/node";

const storage = s3Storage({
  region: process.env.AWS_REGION!,
  bucket: process.env.BUCKET!,
  credentials: fromEksPodIdentity(),
});
```

Refresh is automatic: the signer caches credentials until 5 minutes
before `expiration`, then calls the provider again. Concurrent
refreshes are single-flighted.

> **IRSA vs. EKS Pod Identity:** if your cluster still uses IRSA
> (pre-2023), env vars are `AWS_WEB_IDENTITY_TOKEN_FILE` +
> `AWS_ROLE_ARN` instead, and the app does the STS dance directly.
> baerly-storage doesn't ship a native IRSA provider yet — write a small
> one against the seam, or import `fromTokenFile()` from
> `@aws-sdk/credential-providers`.

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
