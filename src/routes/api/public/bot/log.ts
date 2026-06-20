import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { admin, authBot } from "@/lib/bot-auth.server";

const schema = z.object({
  event_id: z.string().uuid(),
  level: z.enum(["info", "wait", "success", "error", "warning", "api"]).default("info"),
  message: z.string().min(1).max(2000),
});

export const Route = createFileRoute("/api/public/bot/log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const a = await authBot(request);
        if (a instanceof Response) return a;
        const body = schema.safeParse(await request.json());
        if (!body.success) return new Response("Invalid body", { status: 400 });
        const { error } = await admin().from("logs").insert({
          user_id: a.userId,
          event_id: body.data.event_id,
          level: body.data.level,
          message: body.data.message,
        });
        if (error) return new Response(error.message, { status: 500 });
        return Response.json({ ok: true });
      },
    },
  },
});
