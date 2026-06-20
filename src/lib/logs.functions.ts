import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { localDb } from "./local-db";

export const getEventLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ event_id: z.string().uuid(), limit: z.number().int().max(200).default(100) }).parse(d),
  )
  .handler(async ({ data }) => {
    return localDb.getEventLogs(data.event_id, data.limit);
  });

export const clearEventLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ event_id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await localDb.clearEventLogs(data.event_id);
    return { ok: true };
  });
