import { notFound, objectResponse, parseBucketPath } from "@/utils/bucket";
import { can_access_path, unauthorized } from "@/utils/auth";

export async function onRequestGet(context) {
  const [bucket, path] = parseBucketPath(context);
  if (!bucket || !path) return notFound();
  if (!(await can_access_path(context, path))) return unauthorized("没有读取权限");

  const headers = new Headers();
  if (path.startsWith("_$flaredrive$/thumbnails/")) {
    headers.set("Cache-Control", "max-age=31536000, immutable");
  }

  return objectResponse(bucket, path, context.request, { headers });
}
