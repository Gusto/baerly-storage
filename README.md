# baerly-storage

A vendorless document database that runs over any S3-compatible
storage API. The data lives in *your* bucket; mechanical export to
SQL is a first-class feature, not an afterthought.

> Status: under heavy redesign. The project began as a fork of
> [MPS3](https://github.com/endpointservices/mps3), a browser-direct
> multiplayer DB, and has been rewritten as baerly-storage, a
> FaaS-fronted server. The protocol kernel roughly remains, but the
> deployment shape has changed.

Tested with S3, Backblaze, R2 and self-hosted solutions like Minio.

## API

To use this library you construct a `Db` class.

[Db class](packages/server/src/db.ts)

### Authorization

There is no in-built authorization. Every use-case needs different authorization. A malicious user could sabotage the manifest file if they have unrestricted write permissions to the manifest file, but not all use-cases have malicious users. There are a few options:-

- Share access key only to trusted personal.
- If using S3 and IAM, issue STS tokens that grant access to a subpath of a bucket per user/team
- For public use, front the bucket with a trusted server (e.g. a Cloudflare Worker) that authenticates the caller and validates manifest changes before passthrough.


### Advanced Usage

Consult the [API Documentation](packages/server/src/db.ts) for advanced usage.
- atomic batch operations
- multiple manifests
