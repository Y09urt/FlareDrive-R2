import { getSessionUser, json, publicUser } from "@/utils/auth";

export async function onRequestGet(context) {
  const user = await getSessionUser(context);
  return json({ user: publicUser(user) });
}
