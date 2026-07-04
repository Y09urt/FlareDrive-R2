import { getSessionUser, json, unauthorized } from "@/utils/auth";

function getPasteId(context: any) {
  const value = (context.params.id || [])[0];
  return value ? Number(value) : null;
}

export async function onRequestGet(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized();

  const id = getPasteId(context);
  if (id) {
    const paste = await context.env.DB.prepare(
      "SELECT id, title, content, created_at, updated_at FROM pastes WHERE id = ? AND user_id = ?"
    )
      .bind(id, user.id)
      .first();
    if (!paste) return json({ error: "文字不存在" }, { status: 404 });
    return json({ paste });
  }

  const rows = await context.env.DB.prepare(
    `SELECT id, title, substr(content, 1, 160) AS preview, created_at, updated_at
     FROM pastes
     WHERE user_id = ?
     ORDER BY updated_at DESC
     LIMIT 100`
  )
    .bind(user.id)
    .all();
  return json({ pastes: rows.results || [] });
}

export async function onRequestPost(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized();

  const body = await context.request.json().catch(() => ({}));
  const title = String(body.title || "未命名").slice(0, 120);
  const content = String(body.content || "");
  const now = new Date().toISOString();

  const result = await context.env.DB.prepare(
    "INSERT INTO pastes (user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(user.id, title, content, now, now)
    .run();

  return json({ id: result.meta.last_row_id }, { status: 201 });
}

export async function onRequestPut(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized();

  const id = getPasteId(context);
  if (!id) return json({ error: "缺少文字 ID" }, { status: 400 });

  const body = await context.request.json().catch(() => ({}));
  const title = String(body.title || "未命名").slice(0, 120);
  const content = String(body.content || "");
  const result = await context.env.DB.prepare(
    "UPDATE pastes SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?"
  )
    .bind(title, content, new Date().toISOString(), id, user.id)
    .run();

  if (!result.meta.changes) return json({ error: "文字不存在" }, { status: 404 });
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized();

  const id = getPasteId(context);
  if (!id) return json({ error: "缺少文字 ID" }, { status: 400 });

  const result = await context.env.DB.prepare(
    "DELETE FROM pastes WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .run();
  if (!result.meta.changes) return json({ error: "文字不存在" }, { status: 404 });
  return new Response(null, { status: 204 });
}
