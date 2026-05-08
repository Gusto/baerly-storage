<p align="center" width="100%">
    <img width="80%" src="docs/diagrams/vendorless_db_over_s3.svg">
</p>

# MPS3
⚠️ Under development

## Vendorless Multiplayer Database over *any* s3-compatible storage API. 

- Avoid vendor lock-in, your data stays with you.
- Built for operational simplicity
    - no infra to setup and manage apart from the storage bucket.
- Designed for correctness
    - [sync protocol](docs/sync_protocol.md) is [causally consistent](docs/causal_consistency_checking.md) under concurrent writes.
- Web optimized, 10x smaller than the AWS S3 browser client.
- Offline-first, fast page loads and no lost writes.


Tested with S3, Backblaze, R2 and self-hosted solutions like Minio. Interactive demo available on [Observable](https://observablehq.com/@tomlarkworthy/mps3-vendor-examples)


## Concepts

MPS3 is a key-value document store. A manifest lists all keys in the DB as references to files hosted on s3. Setting a key first writes the content to storage, then updates the manifest. To enable subscriptions, the client polls the manifest for changes. To enable causally consistent concurrent writes, the manifest is represented as a time indexed log of patches and checkpoints which is resolved on read.

### Read more

MPS3 is built on strong theoretical foundations. Technical articles are written in [/docs](docs/), some highlights:- 

- [Randomized, Efficient, Causal consistency checking](docs/causal_consistency_checking.md)
- [JSON Merge Patch: Algebra and Applications](docs/JSON_merge_patch.md) 
- [The sync protocol for a client-side, causally consistent, multiplayer DB over the S3 API.md](docs/sync_protocol.md))


## API

To use this library you construct an MP3S class.


[mps3 class](docs/api/classes/MPS3.md)

### Quick start ([Codepen](https://codepen.io/tomlarkworthy/pen/QWzybxd))
```js
import {MPS3} from 'https://cdn.skypack.dev/mps3@0.0.58?min';

const mps3 = new MPS3({
  defaultBucket: "<BUCKET>",
  s3Config: {
    region: "<REGION>",
    credentials: {
      accessKeyId: "<ACCESS_KEY>",
      secretAccessKey: "<SECRET_KEY>"
    }
  }
});

mps3.put("key", "myValue"); // can await for confirmation

mps3.subscribe("key", (val) => console.log(val)); // causally consist listeners

const value = await mps3.get("key"); // read-after-write consist
```



### CORS

For the client to work properly some CORS configuration is required on the bucket so the Javascript environment can observe relevant
 metadata.

```ini
[{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "DELETE"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["X-Amz-Version-Id", "ETag", "Date"]
}]
```
### Authorization

There is no in-built authorization. Every use-case needs different authorization. A malicious user could sabotage the manifest file if they have unrestricted write permissions to the manifest file, but not all use-cases have malicious users. There are a few options:-

- Share access key only to trusted personal.
- If using S3 and IAM, issue STS tokens that grant access to a subpath of a bucket per user/team
- For public use, use a third-party auth solution and a authenticating proxy. Verify manifest changes are valid during passthrough, there is an example of an proxy configuration [here](mps3-proxy.endpointservices.workers.dev/) that hides credentials from the browser using a CloudFlare worker.


### Advanced Usage

Consult the [API Documentation
](docs/api/classes/MPS3.md) for advanced usage.
- atomic batch operations
- multiple manifests
