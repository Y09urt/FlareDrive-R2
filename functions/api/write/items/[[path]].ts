import { notFound, parseBucketPath } from "@/utils/bucket";
import { getSessionUser, get_auth_status, json, unauthorized } from "@/utils/auth";

async function requireWriteAccess(context: any) {
  if (await get_auth_status(context)) return null;
  return unauthorized("没有操作权限");
}

function badRequest(message: string) {
  return json({ error: message }, { status: 400 });
}

function uploadError(error: any) {
  const message = error instanceof Error ? error.message : "Upload failed";
  console.error("R2 write failed", message);
  return json({ error: message }, { status: 500 });
}

async function buildCustomMetadata(context: any, request: Request, source?: any) {
  const customMetadata: Record<string, string> = {};
  const user = await getSessionUser(context);

  if (request.headers.has("fd-thumbnail")) {
    customMetadata.thumbnail = request.headers.get("fd-thumbnail") || "";
  } else if (source?.customMetadata?.thumbnail) {
    customMetadata.thumbnail = source.customMetadata.thumbnail;
  }

  if (user) {
    customMetadata.ownerId = String(user.id);
    customMetadata.ownerUsername = String(user.username);
  }

  return customMetadata;
}

export async function onRequestPostCreateMultipart(context) {
  const denied = await requireWriteAccess(context);
  if (denied) return denied;

  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();
  if (!path) return badRequest("Missing object key");

  const request: Request = context.request;
  const customMetadata = await buildCustomMetadata(context, request);

  let multipartUpload;
  try {
    multipartUpload = await bucket.createMultipartUpload(path, {
      httpMetadata: {
        contentType: request.headers.get("content-type"),
      },
      customMetadata,
    });
  } catch (error) {
    return uploadError(error);
  }

  return new Response(
    JSON.stringify({
      key: multipartUpload.key,
      uploadId: multipartUpload.uploadId,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export async function onRequestPostCompleteMultipart(context) {
  const denied = await requireWriteAccess(context);
  if (denied) return denied;

  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();
  if (!path) return badRequest("Missing object key");

  const request: Request = context.request;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return badRequest("Missing uploadId");
  const completeBody: any = await request.json().catch(() => null);
  if (!Array.isArray(completeBody?.parts)) {
    return badRequest("Missing multipart parts");
  }

  try {
    const multipartUpload = await bucket.resumeMultipartUpload(path, uploadId);
    const object = await multipartUpload.complete(completeBody.parts);
    return new Response(null, {
      headers: { etag: object.httpEtag },
    });
  } catch (error: any) {
    return json({ error: error.message }, { status: 400 });
  }
}

export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.has("uploads")) {
    return onRequestPostCreateMultipart(context);
  }
  if (url.searchParams.has("uploadId")) {
    return onRequestPostCompleteMultipart(context);
  }
  return new Response("Method not allowed", { status: 405 });
}

export async function onRequestPutMultipart(context) {
  const denied = await requireWriteAccess(context);
  if (denied) return denied;

  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();
  if (!path) return badRequest("Missing object key");

  const request: Request = context.request;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return badRequest("Missing uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return badRequest("Invalid partNumber");
  }
  if (!request.body) return badRequest("Missing request body");
  let uploadedPart;
  try {
    const multipartUpload = await bucket.resumeMultipartUpload(path, uploadId);
    uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);
  } catch (error) {
    return uploadError(error);
  }

  return new Response(null, {
    headers: {
      "Content-Type": "application/json",
      etag: uploadedPart.etag,
    },
  });
}

export async function onRequestPut(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.has("uploadId")) {
    return onRequestPutMultipart(context);
  }

  const denied = await requireWriteAccess(context);
  if (denied) return denied;

  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();
  if (!path) return badRequest("Missing object key");

  const request: Request = context.request;
  let content = request.body;
  let source: any = null;

  if (request.headers.has("x-amz-copy-source")) {
    const sourceName = decodeURIComponent(
      request.headers.get("x-amz-copy-source")
    );
    source = await bucket.get(sourceName);
    if (!source) return notFound();
    content = source.body;
  }
  const customMetadata = await buildCustomMetadata(context, request, source);

  let obj;
  try {
    obj = await bucket.put(path, content, {
      httpMetadata: {
        contentType: request.headers.get("content-type"),
      },
      customMetadata,
    });
  } catch (error) {
    return uploadError(error);
  }
  const { key, size, uploaded } = obj;
  return new Response(JSON.stringify({ key, size, uploaded }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestDelete(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized("没有操作权限");

  const [bucket, path] = parseBucketPath(context);
  if (!bucket) return notFound();
  if (!path) return badRequest("Missing object key");

  if (user.role !== "admin") {
    if (user.access_mode === "upload_only") {
      return unauthorized("仅上传账号不能删除文件");
    }
    const object = await bucket.head(path);
    if (!object) return notFound();
    if (object.customMetadata?.ownerId !== String(user.id)) {
      return unauthorized("只能删除自己上传的文件");
    }
  }

  await bucket.delete(path);
  return new Response(null, { status: 204 });
}
