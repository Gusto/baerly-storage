import { MPS3Error } from "./errors";

const stores = new Map<string, Map<string, BodyInit | null | undefined>>();

const storeFor = (bucket: string): Map<string, BodyInit | null | undefined> => {
  let store = stores.get(bucket);
  if (!store) {
    store = new Map();
    stores.set(bucket, store);
  }
  return store;
};

export const fetchFn = async (url_: string, init?: RequestInit): Promise<Response> => {
  const url = new URL(url_);
  const params = new URLSearchParams(url.search);
  const segments = url.pathname.split("/");
  const bucket = segments[1];
  const key = segments.slice(2).join("/");
  if (!bucket) throw new MPS3Error("InvalidConfig", `Invalid bucket in URL: ${url_}`);
  const store = storeFor(bucket);
  let body: BodyInit | null | undefined;
  let status = 200;
  if (params.get("list-type")) {
    const prefix = encodeURIComponent(params.get("prefix") || "");
    const start_at = encodeURIComponent(params.get("start-after") || "");
    const list = [...store.keys()].filter((k) => k.startsWith(prefix) && k > start_at);
    body = `<ListBucketResult>${list
      .map((key) => `<Contents><Key>${key}</Key></Contents>`)
      .join("")}</ListBucketResult>`;
  } else if (init?.method === "GET") {
    body = store.get(key);
    status = body === undefined ? 404 : 200;
  } else if (init?.method === "PUT") {
    body = await init.body;
    store.set(key, body);
  } else if (init?.method === "DELETE") {
    store.delete(key);
  } else {
    throw new MPS3Error("Internal", `Unsupported method: ${init?.method ?? "(none)"}`);
  }
  return new Response(body, { status });
};

export const reset = (): void => {
  stores.clear();
};
