/**
 * Minimal S3 wire-protocol types — replaces the type-only surface we
 * historically pulled from `@aws-sdk/client-s3`. Field names mirror the
 * S3 REST API exactly (PascalCase) so consumers don't need to change.
 *
 * The dependency was eliminated because production code already speaks
 * raw HTTP via `aws4fetch` (see {@link S3ClientLite}); the SDK was only
 * contributing types and a handful of test-fixture calls.
 */

import type { S3VersionId } from "@baerly/protocol";

export interface S3ClientConfig {
  endpoint?: string;
  region?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export interface CommandMetadata {
  httpStatusCode?: number;
}

export interface GetObjectCommandInput {
  Bucket?: string;
  Key?: string;
  VersionId?: S3VersionId;
  IfNoneMatch?: string;
}

export interface GetObjectCommandOutput {
  $metadata: CommandMetadata;
  Body?: unknown;
  ETag?: string;
  VersionId?: S3VersionId;
}

export interface PutObjectCommandInput {
  Bucket?: string;
  Key?: string;
  Body?: string;
  ContentType?: string;
}

export interface PutObjectCommandOutput {
  $metadata: CommandMetadata;
  ETag?: string;
  VersionId?: S3VersionId;
}

export interface DeleteObjectCommandInput {
  Bucket?: string;
  Key?: string;
}

export interface DeleteObjectCommandOutput {
  $metadata: CommandMetadata;
}

export interface ListObjectsV2CommandInput {
  Bucket?: string;
  Prefix?: string;
  StartAfter?: string;
}

export interface ListObjectsV2CommandOutput {
  $metadata: CommandMetadata;
  Contents?: Array<{ ETag?: string; Key?: string; LastModified?: Date }>;
  KeyCount?: number;
  ContinuationToken?: string;
  NextContinuationToken?: string;
  StartAfter?: string;
}
