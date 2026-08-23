import {
  createSession,
  json,
  publicUser,
  verifyPassword,
} from "@/utils/auth";

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    return json({ error: "请输入账号和密码" }, { status: 400 });
  }

  const user = await context.env.DB.prepare(
    "SELECT id, username, password_hash, role, access_mode, expires_at FROM users WHERE username = ?"
  )
    .bind(username)
    .first();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "账号或密码不正确" }, { status: 401 });
  }
  if (user.expires_at && Number(user.expires_at) <= Math.floor(Date.now() / 1000)) {
    return json({ error: "账号已过期" }, { status: 403 });
  }

  const session = await createSession(context, user.id);
  const headers = new Headers({ "Set-Cookie": session.cookie });
  return json({ user: publicUser(user) }, { headers });
}
