import { createSession, hashPassword, json, publicUser } from "@/utils/auth";

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  if (!USERNAME_RE.test(username)) {
    return json(
      { error: "账号只能包含 3-32 位字母、数字、下划线或短横线" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return json({ error: "密码至少需要 8 位" }, { status: 400 });
  }

  const countRow = await context.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).first();
  const isFirstUser = Number(countRow?.count || 0) === 0;
  if (!isFirstUser && context.env.ALLOW_SIGNUP !== "true") {
    return json({ error: "当前站点未开放注册" }, { status: 403 });
  }

  const passwordHash = await hashPassword(password);
  const role = isFirstUser ? "admin" : "user";

  try {
    const result = await context.env.DB.prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(username, passwordHash, role, new Date().toISOString())
      .run();

    const user = {
      id: result.meta.last_row_id,
      username,
      role,
    };
    const session = await createSession(context, user.id);
    return json(
      { user: publicUser(user) },
      { status: 201, headers: { "Set-Cookie": session.cookie } }
    );
  } catch (error: any) {
    if (String(error.message || error).includes("UNIQUE")) {
      return json({ error: "账号已存在" }, { status: 409 });
    }
    throw error;
  }
}
