import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { admin, authBot } from "@/lib/bot-auth.server";

const schema = z.object({
  event_id: z.string().uuid(),
  setor: z.string().max(120).nullable().optional(),
  quantidade: z.number().int().min(1).max(3).nullable().optional(),
  status: z.enum(["Sucesso", "Falhou", "Cancelado"]),
});

export const Route = createFileRoute("/api/public/bot/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const a = await authBot(request);
        if (a instanceof Response) return a;
        const body = schema.safeParse(await request.json());
        if (!body.success) return new Response("Invalid body", { status: 400 });
        const db = admin();
        const { error } = await db.from("results").insert({
          user_id: a.userId,
          event_id: body.data.event_id,
          setor: body.data.setor ?? null,
          quantidade: body.data.quantidade ?? null,
          status: body.data.status,
        });
        if (error) return new Response(error.message, { status: 500 });
        if (body.data.status === "Sucesso")
          await db.from("events").update({ status: "concluido" }).eq("id", body.data.event_id);
        return Response.json({ ok: true });
      },
    },
  },
});
