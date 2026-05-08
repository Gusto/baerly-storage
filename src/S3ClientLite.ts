import {
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  ListObjectsV2CommandInput,
  ListObjectsV2CommandOutput,
  PutObjectCommandInput,
  PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import * as time from "time";
import { MPS3 } from "mps3";
import { parseListObjectsV2CommandOutput } from "xml";

export type FetchFn = (url: string, options?: object) => Promise<Response>;

const retry = async <T>(
  fn: () => Promise<T>,
  { retries = Number.MAX_VALUE, delay = 100, max_delay = 10000 } = {}
): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
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
    private mps3: MPS3
  ) {}

  private getUrl(bucket: string, key?: string, additional?: string) {
    return `${this.endpoint}/${bucket}${
      key ? `/${encodeURIComponent(key)}` : ""
    }${additional || ""}`;
  }

  async listObjectV2(
    command: ListObjectsV2CommandInput
  ): Promise<ListObjectsV2CommandOutput> {
    for (let i = 0; i < 10; i++) {
      const url = this.getUrl(
        command.Bucket!,
        undefined,
        `/?list-type=2&prefix=${command.Prefix}&start-after=${command.StartAfter}`
      );
      const response = await retry(() => this.fetch(url, {}));

      if (response.status === 200) {
        return parseListObjectsV2CommandOutput(
          await response.text(),
          this.mps3.config.parser
        );
      } else if (response.status === 429) {
        console.warn("listObjectV2: 429, retrying");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        throw new Error(
          `Unexpected response: ${response.status} ${await response.text()}`
        );
      }
    }
    throw new Error("Cannot contact server");
  }

  async putObject({
    Bucket,
    Key,
    Body,
    ChecksumSHA256,
  }: PutObjectCommandInput): Promise<PutObjectCommandOutput & { Date: Date }> {
    const url = this.getUrl(Bucket!, Key);
    const response = await retry(() =>
      time.adjustClock(
        this.fetch(url, {
          method: "PUT",
          body: Body as string,
          headers: {
            "Content-Type": "application/json",
            //...(ChecksumSHA256 && { "x-amz-content-sha256": ChecksumSHA256 }),
          },
        }),
        this.mps3.config
      )
    );
    if (response.status !== 200)
      throw new Error(`Failed to PUT: ${await response.text()}`);

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
    const response = await retry(() =>
      this.fetch(this.getUrl(Bucket!, Key), { method: "DELETE" })
    );
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
      VersionId ? `?versionId=${VersionId}` : ""
    );
    const response = await retry(() =>
      time.adjustClock(
        this.fetch(url, {
          method: "GET",
          headers: { "If-None-Match": IfNoneMatch! },
        }),
        this.mps3.config
      )
    );

    switch (response.status) {
      case 404:
        return { $metadata: { httpStatusCode: 404 } };
      case 403:
        throw new Error("Access denied");
      default: {
        let content;
        const type = response.headers.get("content-type");
        const text = await response.text();

        if (type === "application/json" || (text && text !== "")) {
          try {
            content = JSON.parse(text);
          } catch (e) {
            throw new Error(`Failed to parse response as JSON ${url}`);
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
