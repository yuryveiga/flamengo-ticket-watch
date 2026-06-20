import { createFileRoute } from "@tanstack/react-router";
import { admin, authBot } from "@/lib/bot-auth.server";
import { decryptText } from "@/lib/crypto.server";

export const Route = createFileRoute("/api/public/bot/poll")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const a = await authBot(request);
        if (a instanceof Response) return a;
        const db = admin();

        // Fetch unconsumed commands for this user, oldest first
        const { data: cmds } = await db
          .from("bot_commands")
          .select("id, event_id, command, created_at")
          .eq("user_id", a.userId)
          .is("consumed_at", null)
          .order("created_at", { ascending: true })
          .limit(20);

        if (!cmds?.length) return Response.json({ commands: [] });

        const eventIds = [...new Set(cmds.map((c) => c.event_id))];
        const { data: events } = await db.from("events").select("*").in("id", eventIds);
        const eventMap = new Map((events ?? []).map((e) => [e.id, e]));

        const out = [] as Array<Record<string, unknown>>;
        for (const c of cmds) {
          const ev = eventMap.get(c.event_id);
          if (!ev) continue;
          const cfg = ev.config as Record<string, unknown>;
          let senha = "";
          try {
            senha = await decryptText((cfg.senha_enc as string) || "");
          } catch {
            /* ignore */
          }
          out.push({
            command_id: c.id,
            event_id: c.event_id,
            command: c.command,
            url: ev.url,
            config: {
              email: cfg.email,
              senha,
              setores: cfg.setores,
              quantidade: cfg.quantidade,
              intervalo: cfg.intervalo,
              aceitar_qualquer: cfg.aceitar_qualquer,
              headless: cfg.headless,
            },
          });
        }

        // Mark commands consumed
        await db
          .from("bot_commands")
          .update({ consumed_at: new Date().toISOString() })
          .in(
            "id",
            cmds.map((c) => c.id),
          );

        return Response.json({ commands: out });
      },
    },
  },
});
