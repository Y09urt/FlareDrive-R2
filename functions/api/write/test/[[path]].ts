import { get_auth_status, unauthorized } from "@/utils/auth";

export async function onRequest(context) {
  if (!(await get_auth_status(context))) return unauthorized("没有操作权限");
  return new Response("access", { status: 200 });
}
