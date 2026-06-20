import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export function admin() {
  return createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function authBot(request: Request): Promise<{ userId: string } | Response> {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return new Response("Missing token", { status: 401 });
  const { data, error } = await admin()
    .from("bot_tokens")
    .select("user_id")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return new Response("Invalid token", { status: 401 });
  return { userId: data.user_id };
}
