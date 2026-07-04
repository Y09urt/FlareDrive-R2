import { notFound, parseBucketPath } from "@/utils/bucket";

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function onRequestGet(context) {
  const token = String((context.params.token || [])[0] || "");
  if (!token) return notFound();

  const now = Math.floor(Date.now() / 1000);
  const share = await context.env.DB.prepare(
    `SELECT token, kind, object_key, paste_id, expires_at
     FROM shares
     WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)`
  )
    .bind(token, now)
    .first();
  if (!share) return notFound();

  if (share.kind === "paste") {
    const paste = await context.env.DB.prepare(
      "SELECT title, content, updated_at FROM pastes WHERE id = ?"
    )
      .bind(share.paste_id)
      .first();
    if (!paste) return notFound();

    const title = htmlEscape(paste.title || "文字暂存");
    const content = htmlEscape(paste.content || "");
    return new Response(
      `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8fa;color:#1f2937}
    main{max-width:860px;margin:0 auto;padding:32px 18px}
    pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;line-height:1.65}
  </style>
</head>
<body><main><h1>${title}</h1><pre>${content}</pre></main></body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const [bucket] = parseBucketPath(context);
  if (!bucket) return notFound();
  const object = await bucket.get(share.object_key);
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(
      String(share.object_key).split("/").pop() || "download"
    )}"`
  );
  return new Response(object.body, { headers });
}
