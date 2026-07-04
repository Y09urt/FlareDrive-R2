export function notFound() {
  return new Response("Not found", { status: 404 });
}

function rangeNotSatisfiable(size: number) {
  return new Response("Range Not Satisfiable", {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${size}`,
    },
  });
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseBucketPath(context): [any, string] {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const rawPath = params.path;
  const pathSegments = (Array.isArray(rawPath) ? rawPath : rawPath ? [rawPath] : []) as string[];
  const path = pathSegments.map((segment) => safeDecode(segment)).join("/");
  const driveid = url.hostname.replace(/\..*/, "");

  return [env[driveid] || env["BUCKET"], path];
}

function parseRangeHeader(rangeHeader: string | null, size: number) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { invalid: true };

  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    const length = Math.min(suffix, size);
    return {
      offset: Math.max(size - length, 0),
      length,
      end: size - 1,
    };
  }

  const offset = Number(startText);
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) {
    return { invalid: true };
  }

  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(requestedEnd) || requestedEnd < offset) {
    return { invalid: true };
  }

  const end = Math.min(requestedEnd, size - 1);
  return {
    offset,
    length: end - offset + 1,
    end,
  };
}

export async function objectResponse(
  bucket: any,
  key: string,
  request: Request,
  init: ResponseInit = {}
) {
  const head = await bucket.head(key);
  if (!head) return notFound();

  const baseHeaders = new Headers(init.headers);
  head.writeHttpMetadata(baseHeaders);
  baseHeaders.set("Accept-Ranges", "bytes");
  baseHeaders.set("etag", head.httpEtag);

  const range = parseRangeHeader(request.headers.get("Range"), head.size);
  if (range?.invalid) return rangeNotSatisfiable(head.size);

  if (!range) {
    const object = await bucket.get(key);
    if (!object) return notFound();
    baseHeaders.set("Content-Length", String(head.size));
    return new Response(object.body, {
      ...init,
      status: init.status || 200,
      headers: baseHeaders,
    });
  }

  const object = await bucket.get(key, {
    range: { offset: range.offset, length: range.length },
  });
  if (!object) return notFound();

  baseHeaders.set("Content-Length", String(range.length));
  baseHeaders.set("Content-Range", `bytes ${range.offset}-${range.end}/${head.size}`);
  return new Response(object.body, {
    ...init,
    status: 206,
    headers: baseHeaders,
  });
}
