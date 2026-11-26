import { NextResponse, type NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/lib/supabase-store";

export async function proxy(request: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return NextResponse.next();
  }
  return refreshSupabaseSession(request);
}

// Server-rendered pages cannot persist refreshed cookies themselves. Route handlers can.
export const config = { matcher: ["/"] };
