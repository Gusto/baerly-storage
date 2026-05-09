# S3 key-escaping fixtures

Empty files whose *names* are the tricky S3 keys documented in
[`docs/s3-xml-escaping-cases.md`](../../docs/s3-xml-escaping-cases.md).
Re-upload them to a bucket to reproduce how S3 encodes them in
`ListObjectsV2` XML responses.
