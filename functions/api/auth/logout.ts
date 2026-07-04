import { clearSessionCookie, destroySession, json } from "@/utils/auth";

export async function onRequestPost(context) {
  await destroySession(context);
  return json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookie(context) } }
  );
}
