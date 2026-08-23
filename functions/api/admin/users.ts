import {
  getSessionUser,
  hashPassword,
  json,
  publicUser,
} from "@/utils/auth";

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const ROLES = new Set(["admin", "user"]);
const ACCESS_MODES = new Set(["upload_only", "download_only", "read_write"]);

function requireAdmin(user: any) {
  return user?.role === "admin";
}

function parseExpiresAt(value: unknown): { value: number | null; error?: string } {
  if (value === null || value === undefined || value === "") return { value: null };
  const expiresAt = Number(value);
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return { value: null, error: "有效期必须是未来时间" };
  }
  return { value: expiresAt };
}

export async function onRequestGet(context) {
  const currentUser = await getSessionUser(context);
  if (!requireAdmin(currentUser)) {
    return json({ error: "需要管理员权限" }, { status: 403 });
  }

  const rows = await context.env.DB.prepare(
    `SELECT id, username, role, access_mode, expires_at, created_at
     FROM users
     ORDER BY id ASC`
  ).all();

  return json({
    users: (rows.results || []).map(publicUser),
  });
}

export async function onRequestPost(context) {
  const currentUser = await getSessionUser(context);
  if (!requireAdmin(currentUser)) {
    return json({ error: "需要管理员权限" }, { status: 403 });
  }

  const body = await context.request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const role = String(body.role || "user");
  const accessMode = String(body.accessMode || "read_write");
  const expiresAt = parseExpiresAt(body.expiresAt);

  if (!USERNAME_RE.test(username)) {
    return json(
      { error: "账号只能包含 3-32 位字母、数字、下划线或短横线" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return json({ error: "密码至少需要 8 位" }, { status: 400 });
  }
  if (!ROLES.has(role)) {
    return json({ error: "权限只能选择管理员或普通用户" }, { status: 400 });
  }
  if (!ACCESS_MODES.has(accessMode)) {
    return json({ error: "文件权限只能选择仅上传、仅下载或上传下载" }, { status: 400 });
  }
  if (expiresAt.error) {
    return json({ error: expiresAt.error }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);

  try {
    const result = await context.env.DB.prepare(
      `INSERT INTO users
        (username, password_hash, role, access_mode, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        username,
        passwordHash,
        role,
        accessMode,
        expiresAt.value,
        new Date().toISOString()
      )
      .run();

    return json(
      {
        user: publicUser({
          id: result.meta.last_row_id,
          username,
          role,
          access_mode: accessMode,
          expires_at: expiresAt.value,
          created_at: new Date().toISOString(),
        }),
      },
      { status: 201 }
    );
  } catch (error: any) {
    if (String(error.message || error).includes("UNIQUE")) {
      return json({ error: "账号已存在" }, { status: 409 });
    }
    throw error;
  }
}
