const THUMBNAIL_PREFIX = "_$flaredrive$/thumbnails/";
const SESSION_COOKIE = "fd_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function digestHex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function unauthorized(message = "需要登录") {
  const headers = new Headers();
  headers.set("WWW-Authenticate", 'Basic realm="FlareDrive"');
  return json({ error: message }, { status: 401, headers });
}

export function parseAllowList(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function matchesAllowList(targetPath: string, allowList: string[]) {
  if (allowList.includes("*")) return true;
  return allowList.some((allow) => targetPath.startsWith(allow));
}

function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function cookieOptions(context: any, maxAge: number) {
  const url = new URL(context.request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(context: any) {
  return `${SESSION_COOKIE}=; ${cookieOptions(context, 0)}`;
}

export function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Password(password: string, salt: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${salt}:${password}`)
  );
  return bytesToHex(new Uint8Array(digest));
}

async function pbkdf2Password(
  password: string,
  salt: string,
  iterations: number
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(salt),
      iterations,
    },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashPassword(password: string, salt = randomHex(16)) {
  return `sha256$${salt}$${await sha256Password(password, salt)}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, iterations, salt, expected] = storedHash.split("$");
  if (scheme === "sha256") {
    const [, shaSalt, shaExpected] = storedHash.split("$");
    if (!shaSalt || !shaExpected) return false;
    return (await sha256Password(password, shaSalt)) === shaExpected;
  }

  if (scheme !== "pbkdf2_sha256" || !iterations || !salt || !expected) {
    return false;
  }

  return (await pbkdf2Password(password, salt, Number(iterations))) === expected;
}

export async function createSession(context: any, userId: number) {
  const token = randomHex(32);
  const tokenHash = await digestHex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;

  await context.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(tokenHash, userId, now, expiresAt)
    .run();

  return {
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(
      context,
      SESSION_TTL_SECONDS
    )}`,
  };
}

export async function destroySession(context: any) {
  const token = getCookie(context.request, SESSION_COOKIE);
  if (token && context.env.DB) {
    await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await digestHex(token))
      .run();
  }
}

export async function getSessionUser(context: any) {
  if (!context.env.DB) return null;
  const token = getCookie(context.request, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = await digestHex(token);
  const now = Math.floor(Date.now() / 1000);
  return context.env.DB.prepare(
    `SELECT users.id, users.username, users.role
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
  )
    .bind(tokenHash, now)
    .first();
}

function getBasicAuthAllowList(context: any) {
  const authorization = context.request.headers.get("Authorization");
  if (authorization && authorization.startsWith("Basic ")) {
    const account = atob(authorization.split("Basic ")[1]);
    if (account && context.env[account]) {
      return parseAllowList(context.env[account]);
    }
  }
  if (context.env.GUEST) {
    return parseAllowList(context.env.GUEST);
  }
  return null;
}

export async function get_allow_list(context: any) {
  const user = await getSessionUser(context);
  if (user) {
    return user.role === "admin" ? ["*"] : [`users/${user.id}/`];
  }
  return getBasicAuthAllowList(context);
}

export async function can_access_path(context: any, targetPath: string) {
  if (targetPath.startsWith(THUMBNAIL_PREFIX)) return true;
  const allowList = await get_allow_list(context);
  if (!allowList) return false;
  return matchesAllowList(targetPath, allowList);
}

export async function get_auth_status(context: any) {
  const dopath = context.request.url.split("/api/write/items/")[1];
  if (!dopath) return false;
  let targetPath = dopath.split("?")[0];
  try {
    targetPath = decodeURIComponent(targetPath);
  } catch {
    return false;
  }
  return can_access_path(context, targetPath);
}

export function publicUser(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    homePrefix: user.role === "admin" ? "" : `users/${user.id}/`,
  };
}
