declare module "aws4fetch" {
  export interface AwsClientOptions {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region?: string;
    service?: string;
    retries?: number;
  }

  export class AwsClient {
    constructor(options: AwsClientOptions);
    fetch(url: string, options?: object): Promise<Response>;
  }
}
