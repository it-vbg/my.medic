import { cookies, headers } from "next/headers";
import path from "node:path";
import { createLocalStore } from "./local-store";
import { createSupabaseStore } from "./supabase-store";
import type { CabinetStore } from "./cabinet";

export async function getStore(readOnly = false): Promise<CabinetStore> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url && key) return createSupabaseStore(readOnly);
  if (url || key) throw new Error("Incomplete Supabase configuration");
  const jar = await cookies();
  const incoming = await headers();
  const hostname = (incoming.get("host") ?? "").split(":")[0];
  const loopback = ["localhost", "127.0.0.1"].includes(hostname) || incoming.get("host")?.startsWith("[::1]");
  const secure = incoming.get("x-forwarded-proto") === "https" || (process.env.NODE_ENV === "production" && !loopback);
  const directory = process.env.MY_MEDIC_DATA_DIR || path.join(process.cwd(), ".my-medic");
  return createLocalStore(directory, {
    get: () => jar.get("my_medic_session")?.value,
    set: (token) => jar.set("my_medic_session", token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 30 * 86400 }),
    clear: () => jar.delete("my_medic_session"),
  });
}
