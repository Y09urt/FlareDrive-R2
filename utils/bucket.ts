export function notFound() {
  return new Response("Not found", { status: 404 });
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
