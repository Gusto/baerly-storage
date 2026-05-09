import { MPS3Error } from "./errors";

interface StoredObject {
  body: BodyInit | null | undefined;
  contentType?: string;
}

const stores = new Map<string, Map<string, StoredObject>>();

const storeFor = (bucket: string): Map<string, StoredObject> => {
  let store = stores.get(bucket);
  if (!store) {
    store = new Map();
    stores.set(bucket, store);
  }
  return store;
};

const headerOf = (init: RequestInit | undefined, name: string): string | undefined => {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const lower = name.toLowerCase();
    for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return (headers as Record<string, string>)[k];
  }
  return undefined;
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
  let responseContentType: string | undefined;
  if (params.get("list-type")) {
    const prefix = encodeURIComponent(params.get("prefix") || "");
    const start_at = encodeURIComponent(params.get("start-after") || "");
    const list = [...store.keys()].filter((k) => k.startsWith(prefix) && k > start_at);
    body = `<ListBucketResult>${list
      .map((key) => `<Contents><Key>${key}</Key></Contents>`)
      .join("")}</ListBucketResult>`;
    responseContentType = "application/xml";
  } else if (init?.method === "GET") {
    const stored = store.get(key);
    if (stored === undefined) {
      status = 404;
    } else {
      body = stored.body;
      responseContentType = stored.contentType;
    }
  } else if (init?.method === "PUT") {
    body = await init.body;
    store.set(key, { body, contentType: headerOf(init, "Content-Type") });
  } else if (init?.method === "DELETE") {
    store.delete(key);
  } else {
    throw new MPS3Error("Internal", `Unsupported method: ${init?.method ?? "(none)"}`);
  }
  const headers: Record<string, string> = {};
  if (responseContentType) headers["content-type"] = responseContentType;
  return new Response(body, { status, headers });
};

export const reset = (): void => {
  stores.clear();
};
