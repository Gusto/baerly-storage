/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Table<T>`
   declaration); the synthetic seed populates it directly. */

/**
 * `baerly copy` over `S3HttpStorage` against the local Minio that
 * `pnpm dev:storage` provisions. Gated on `MINIO=1` via
 * `describe.runIf`. Re-uses the Minio creds + endpoint from
 * `packages/adapter-node/src/s3-http.conformance.test.ts` — same
 * `pnpm test:minio` invocation activates both.
 *
 * The two buckets `baerly-copy-src` / `baerly-copy-dst` are created in
 * `beforeAll`; `createBucket` tolerates 409 BucketAlreadyOwnedByYou
 * so re-runs against the persistent dev Minio don't fail.
 *
 * Calls `doCopy` directly (not `runCopy`) so the test doesn't depend
 * on `process.env` state for the source-side `S3HttpStorage`
 * construction — both source and target are built with explicit
 * options inside the test.
 */
import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  S3HttpStorage,
  createCurrentJson,
  readCurrentJson,
  type DocumentData,
} from "@baerly/protocol";
import { Db, ServerWriter } from "@baerly/server";
import { doCopy } from "../../packages/cli/src/copy.ts";
import { createBucket } from "../fixtures/s3-fixtures.ts";

const MINIO_ENDPOINT = "http://127.0.0.1:9102";
const MINIO_ACCESS_KEY = "baerly";
const MINIO_SECRET_KEY = "ZOAmumEzdsUUcVlQ";
const MINIO_REGION = "us-east-1";
const SRC_BUCKET = "baerly-copy-src";
const DST_BUCKET = "baerly-copy-dst";

const minioEnabled = process.env["MINIO"] === "1";

const signer = new AwsClient({
  accessKeyId: MINIO_ACCESS_KEY,
  secretAccessKey: MINIO_SECRET_KEY,
  region: MINIO_REGION,
  service: "s3",
});
const sign = (req: Request): Promise<Request> => signer.sign(req);
const xmlParser = new DOMParser();

const makeStorage = (bucket: string): S3HttpStorage =>
  new S3HttpStorage({
    endpoint: MINIO_ENDPOINT,
    bucket,
    sign,
    xmlParser,
  });

interface Doc extends DocumentData {
  _id: string;
  title: string;
  status: "open" | "closed";
}

const APP = "app";
const TENANT = "t";
const COLL = "tickets";

describe.runIf(minioEnabled)("baerly copy @ Minio :9102", () => {
  beforeAll(async () => {
    await createBucket(signer, MINIO_ENDPOINT, SRC_BUCKET);
    await createBucket(signer, MINIO_ENDPOINT, DST_BUCKET);
  });

  test("preserves find() parity across Minio buckets", async () => {
    // Per-test randomised collection so reruns against the persistent
    // dev Minio don't collide. The two buckets host different
    // collection paths; cleanup is "next test uses a fresh prefix."
    const collSuffix = Math.random().toString(36).slice(2, 8);
    const collection = `${COLL}-${collSuffix}`;
    const tablePrefix = `app/${APP}/tenant/${TENANT}/manifests/${collection}`;
    const currentJsonKey = `${tablePrefix}/current.json`;

    const src = makeStorage(SRC_BUCKET);
    const dst = makeStorage(DST_BUCKET);

    await createCurrentJson(src, currentJsonKey, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "copy-minio-test", claimed_at: "" },
    });

    const w = new ServerWriter({ storage: src, currentJsonKey });
    const N = 25;
    await w.commitBatch(
      Array.from({ length: N }, (_, i) => ({
        op: "I" as const,
        collection,
        docId: `doc-${i}`,
        body: {
          _id: `doc-${i}`,
          title: `t-${i}`,
          status: i % 2 ? "closed" : "open",
        } as Doc,
      })),
    );

    const post = await readCurrentJson(src, currentJsonKey);
    expect(post).not.toBeNull();

    await doCopy(
      { storage: src, keyPrefix: "" },
      { storage: dst, keyPrefix: "" },
      { currentJsonKey, expectedEtag: post!.etag },
    );

    const sorted = <T extends { _id: string }>(rs: readonly T[]): T[] =>
      [...rs].toSorted((a, b) => {
        if (a._id < b._id) {
          return -1;
        }
        if (a._id > b._id) {
          return 1;
        }
        return 0;
      });

    const srcRows = await Db.create({ storage: src, app: APP, tenant: TENANT })
      .table<Doc>(collection)
      .where({})
      .all();
    const dstRows = await Db.create({ storage: dst, app: APP, tenant: TENANT })
      .table<Doc>(collection)
      .where({})
      .all();
    expect(sorted(dstRows)).toEqual(sorted(srcRows));
    expect(dstRows.length).toBe(N);
  });
});
