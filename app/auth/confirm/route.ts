import { NextResponse } from "next/server";
import { createSupabaseClient } from "@/lib/supabase-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const go = (path: string) => {
    const response = NextResponse.redirect(new URL(path, url));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
  const expired = () => go("/?auth=expired");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return expired();
  const client = await createSupabaseClient();
  const token = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const code = url.searchParams.get("code");
  if (token && (type === "email" || type === "signup")) {
    const { error } = await client.auth.verifyOtp({ type, token_hash: token });
    if (!error) return go("/");
  } else if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) return go("/");
  }
  return expired();
}
