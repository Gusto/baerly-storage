import { createStore, get, set, del, keys } from "idb-keyval";
export const fetchFn = async (
  url_: string,
  init?: RequestInit
): Promise<Response> => {
  const url = new URL(url_);
  const params = new URLSearchParams(url.search);
  const segments = url.pathname.split("/");
  const bucket = segments[1];
  const key = segments.slice(2).join("/");
  const db = createStore(bucket, "v0");
  let body;
  let status = 200;
  if (params.get("list-type")) {
    const prefix = encodeURIComponent(params.get("prefix") || "");
    const start_at = encodeURIComponent(params.get("start-after") || "");
    const list = (await keys(db)).filter(
      (k) => `${k}`.startsWith(prefix) && `${k}` > start_at
    );
    body = `<ListBucketResult>${list.map(
      (key) => `<Contents><Key>${key}</Key></Contents>`
    )}</ListBucketResult>`;
  } else if (init?.method === "GET") {
    body = await get(key, db);
    status = body === undefined ? 404 : 200;
  } else if (init?.method === "PUT") {
    body = await init.body;
    await set(key, body, db);
  } else if (init?.method === "DELETE") {
    await del(key, db);
  } else {
    throw new Error();
  }
  return new Response(body, { status });
};
