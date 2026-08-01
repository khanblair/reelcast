import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mintConvexJwt } from "@/lib/convex-jwt";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const token = mintConvexJwt(
    user.id,
    user.email,
    user.user_metadata?.full_name ?? user.email,
    user.user_metadata?.avatar_url,
  );

  return NextResponse.json({ token });
}
