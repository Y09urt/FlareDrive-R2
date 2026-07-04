import {
  can_access_path,
  getSessionUser,
  json,
  randomHex,
  unauthorized,
} from "@/utils/auth";

const CUSTOM_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

function normalizeCustomToken(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function tokenError(message: string) {
  return json({ error: message }, { status: 400 });
}

export async function onRequestGet(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized();

  const rows = await context.env.DB.prepare(
    `SELECT token, kind, object_key, paste_id, created_at, expires_at
     FROM shares
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(user.id)
    .all();

  return json({ shares: rows.results || [] });
}

export async function onRequestPost(context) {
  const user = await getSessionUser(context);
  if (!user) return unauthorized();

  const body = await context.request.json().catch(() => ({}));
  const key = String(body.key || "");
  const pasteId = body.pasteId ? Number(body.pasteId) : null;
  const kind = pasteId ? "paste" : "file";
  const customToken = normalizeCustomToken(body.customToken);
  if (customToken && !CUSTOM_TOKEN_PATTERN.test(customToken)) {
    return tokenError("自定义链接只能使用 3-64 位字母、数字、短横线或下划线");
  }
  const token = customToken || randomHex(18);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = body.expiresAt ? Number(body.expiresAt) : null;

  if (kind === "file") {
    if (!key || !(await can_access_path(context, key))) {
      return json({ error: "没有分享该文件的权限" }, { status: 403 });
    }
  } else {
    const paste = await context.env.DB.prepare(
      "SELECT id FROM pastes WHERE id = ? AND user_id = ?"
    )
      .bind(pasteId, user.id)
      .first();
    if (!paste) return json({ error: "文字不存在" }, { status: 404 });
  }

  try {
    await context.env.DB.prepare(
      `INSERT INTO shares
        (token, user_id, kind, object_key, paste_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(token, user.id, kind, key || null, pasteId, now, expiresAt)
      .run();
  } catch (error: any) {
    if (customToken && String(error?.message || "").includes("UNIQUE")) {
      return json({ error: "这个自定义分享链接已经被占用" }, { status: 409 });
    }
    throw error;
  }

  const url = new URL(`/share/${encodeURIComponent(token)}`, context.request.url).toString();
  return json({ token, url }, { status: 201 });
}
