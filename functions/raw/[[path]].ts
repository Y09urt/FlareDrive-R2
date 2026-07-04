import { notFound, parseBucketPath } from "@/utils/bucket";
import { can_access_path, unauthorized } from "@/utils/auth";

export async function onRequestGet(context) {
  const [bucket, path] = parseBucketPath(context);
  if (!bucket || !path) return notFound();
  if (!(await can_access_path(context, path))) return unauthorized("没有读取权限");

  const object = await bucket.get(path);
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (path.startsWith("_$flaredrive$/thumbnails/")) {
    headers.set("Cache-Control", "max-age=31536000, immutable");
  }

  return new Response(object.body, { headers });
}
