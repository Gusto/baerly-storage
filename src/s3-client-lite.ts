import type {
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  ListObjectsV2CommandInput,
  ListObjectsV2CommandOutput,
  PutObjectCommandInput,
  PutObjectCommandOutput,
} from "./s3-types";
import * as time from "./time";
import type { ResolvedMPS3Config } from "./mps3";
import { parseListObjectsV2CommandOutput } from "./xml";
import {
  LIST_OBJECT_MAX_RETRIES,
  MPS3Error,
  RATE_LIMIT_BACKOFF_MILLIS,
  S3_REQUEST_MAX_RETRIES,
} from "@baerly/protocol";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Permanent {@link MPS3Error} codes that must short-circuit `retry`.
 * These represent caller- or environment-level faults where retrying
 * cannot succeed: `AccessDenied` (403 — credentials/policy), `InvalidConfig`
 * (bad bucket / unsupported credential type), and `InvalidResponse`
 * (server returned unparseable data). `NetworkError` is intentionally
 * absent — it covers transient transport faults and stays retryable.
 */
const PERMANENT_ERROR_CODES = new Set(["AccessDenied", "InvalidConfig", "InvalidResponse"]);

const retry = async <T>(
  fn: () => Promise<T>,
  { retries = S3_REQUEST_MAX_RETRIES, delay = 100, max_delay = 10000 } = {},
): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MPS3Error && PERMANENT_ERROR_CODES.has(e.code)) {
      throw e;
    }
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retry(fn, {
        retries: retries - 1,
        max_delay,
        delay: Math.min(delay * 1.5, max_delay),
      });
    }
    throw e;
  }
};

export class S3ClientLite {
  constructor(
    private fetch: FetchFn,
    private endpoint: string,
    private config: ResolvedMPS3Config,
  ) {}

  private getUrl(bucket: string, key?: string, additional?: string) {
    return `${this.endpoint}/${bucket}${
      key ? `/${encodeURIComponent(key)}` : ""
    }${additional || ""}`;
  }

  async listObjectV2(command: ListObjectsV2CommandInput): Promise<ListObjectsV2CommandOutput> {
    for (let i = 0; i < LIST_OBJECT_MAX_RETRIES; i++) {
      const url = this.getUrl(
        command.Bucket!,
        undefined,
        `/?list-type=2&prefix=${encodeURIComponent(command.Prefix ?? "")}` +
          `&start-after=${encodeURIComponent(command.StartAfter ?? "")}`,
      );
      const response = await retry(() => this.fetch(url, {}));

      if (response.status === 200) {
        return parseListObjectsV2CommandOutput(await response.text(), this.config.parser);
      } else if (response.status === 429) {
        this.config.log("listObjectV2: 429, retrying");
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MILLIS));
      } else {
        throw new MPS3Error(
          "NetworkError",
          `Unexpected response: ${response.status} ${await response.text()}`,
        );
      }
    }
    throw new MPS3Error("NetworkError", "Cannot contact server");
  }

  async putObject({
    Bucket,
    Key,
    Body,
  }: PutObjectCommandInput): Promise<PutObjectCommandOutput & { Date: Date }> {
    const url = this.getUrl(Bucket!, Key);
    const response = await retry(() =>
      time.adjustClock(
        this.fetch(url, {
          method: "PUT",
          body: Body as string,
          headers: {
            "Content-Type": "application/json",
          },
        }),
        this.config,
      ),
    );
    if (response.status !== 200)
      throw new MPS3Error("NetworkError", `Failed to PUT: ${await response.text()}`);

    return {
      $metadata: { httpStatusCode: response.status },
      Date: new Date(response.headers.get("date")!),
      ETag: response.headers.get("ETag")!,
      ...(response.headers.get("x-amz-version-id") && {
        VersionId: response.headers.get("x-amz-version-id")!,
      }),
    };
  }

  async deleteObject({
    Bucket,
    Key,
  }: DeleteObjectCommandInput): Promise<DeleteObjectCommandOutput> {
    const response = await retry(() => this.fetch(this.getUrl(Bucket!, Key), { method: "DELETE" }));
    return { $metadata: { httpStatusCode: response.status } };
  }

  async getObject({
    Bucket,
    Key,
    VersionId,
    IfNoneMatch,
  }: GetObjectCommandInput): Promise<GetObjectCommandOutput> {
    const url = this.getUrl(
      Bucket!,
      Key,
      VersionId ? `?versionId=${encodeURIComponent(VersionId)}` : "",
    );
    const response = await retry(() =>
      time.adjustClock(
        this.fetch(url, {
          method: "GET",
          headers: { "If-None-Match": IfNoneMatch! },
        }),
        this.config,
      ),
    );

    switch (response.status) {
      case 404:
        return { $metadata: { httpStatusCode: 404 } };
      case 403:
        throw new MPS3Error("AccessDenied", "Access denied");
      default: {
        if (!response.ok) {
          throw new MPS3Error(
            "InvalidResponse",
            `Unexpected status ${response.status}: ${await response.text()}`,
          );
        }
        let content;
        const rawType = response.headers.get("content-type") ?? "";
        const type = rawType.toLowerCase().split(";")[0]!.trim();
        if (type === "application/json") {
          const text = await response.text();
          try {
            content = JSON.parse(text);
          } catch (e) {
            throw new MPS3Error("InvalidResponse", `Failed to parse response as JSON ${url}`, e);
          }
        }
        return {
          $metadata: { httpStatusCode: response.status },
          Body: content,
          ETag: response.headers.get("ETag")!,
          ...(response.headers.get("x-amz-version-id") && {
            VersionId: response.headers.get("x-amz-version-id")!,
          }),
        };
      }
    }
  }
}
