import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { encryptText } from "./crypto.server";
import { localDb } from "./local-db";

// ─── Validators ───────────────────────────────────────────────────────────────

const configSchema = z.object({
  account_id: z.string().optional().default(""),
  email: z.string().max(255).optional().default(""),
  senha: z.string().max(255).optional().default(""),
  setores: z.array(z.string().min(1).max(120)).max(20).default([]),
  quantidade: z.number().int().min(1).max(3).default(1),
  intervalo: z.number().int().min(5).max(60).default(30),
  aceitar_qualquer: z.boolean().default(false),
  headless: z.boolean().default(true),
  loop_continuo: z.boolean().default(false),
  login_type: z.enum(["normal", "fla_id"]).optional(),
  timer_duration_minutes: z.number().int().min(0).optional(),
  timer_start_time: z.string().optional(),
  timer_end_time: z.string().optional(),
  timer_loop_run_minutes: z.number().int().min(0).optional(),
  timer_loop_pause_minutes: z.number().int().min(0).optional(),
});

// ─── List ─────────────────────────────────────────────────────────────────────

export const listEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await localDb.read();
    return db.events
      .filter((e) => e.user_id === context.userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((e) => ({ ...e, config: sanitizeConfig(e.config) }));
  });

// ─── Get ──────────────────────────────────────────────────────────────────────

export const getEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const row = db.events.find((e) => e.id === data.id && e.user_id === context.userId);
    if (!row) throw new Error("Event not found");
    return { ...row, config: sanitizeConfig(row.config) };
  });

// ─── Create ───────────────────────────────────────────────────────────────────

export const createEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { login_url: string; url: string; name?: string }) =>
    z
      .object({
        login_url: z.string().url().max(500),
        url: z.string().url().max(500),
        name: z.string().max(120).optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const userEvents = db.events.filter((e) => e.user_id === context.userId);
    if (userEvents.length >= 10) throw new Error("Limite de 10 eventos atingido.");

    const newEvent = {
      id: crypto.randomUUID(),
      user_id: context.userId,
      login_url: data.login_url,
      url: data.url,
      name: data.name ?? null,
      status: "pausado" as const,
      config: {} as any,
      created_at: new Date().toISOString(),
      expires_at: null,
    };
    db.events.push(newEvent);
    await localDb.write(db);
    return newEvent;
  });

// ─── Update Event ─────────────────────────────────────────────────────────────

export const updateEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; login_url: string; url: string; name?: string }) =>
    z
      .object({
        id: z.string().uuid(),
        login_url: z.string().url().max(500),
        url: z.string().url().max(500),
        name: z.string().max(120).optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const evIndex = db.events.findIndex(
      (e) => e.id === data.id && e.user_id === context.userId,
    );
    if (evIndex === -1) throw new Error("Event not found");

    db.events[evIndex].login_url = data.login_url;
    db.events[evIndex].url = data.url;
    db.events[evIndex].name = data.name ?? null;

    await localDb.write(db);
    return db.events[evIndex];
  });


// ─── Delete ───────────────────────────────────────────────────────────────────

export const deleteEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    db.events = db.events.filter((e) => !(e.id === data.id && e.user_id === context.userId));
    db.logs = db.logs.filter((l) => l.event_id !== data.id);
    await localDb.write(db);
    return { ok: true };
  });

// ─── Update Config ────────────────────────────────────────────────────────────

export const updateConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), config: configSchema }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const evIndex = db.events.findIndex(
      (e) => e.id === data.id && e.user_id === context.userId,
    );
    if (evIndex === -1) throw new Error("Event not found");

    const existing = db.events[evIndex];
    const prev = (existing.config ?? {}) as Record<string, unknown>;

    // Preserve encrypted password if new password is blank
    const senhaEnc = data.config.senha
      ? await encryptText(data.config.senha)
      : ((prev.senha_enc as string | undefined) ?? "");

    let loginType = data.config.login_type;
    if (!loginType && data.config.account_id && data.config.account_id !== "ALL") {
      const acc = db.accounts.find(a => a.id === data.config.account_id);
      if (acc?.login_type) loginType = acc.login_type;
    }

    db.events[evIndex].config = {
      account_id: data.config.account_id,
      email: data.config.email,
      senha_enc: senhaEnc,
      login_type: loginType ?? "normal",
      setores: data.config.setores,
      quantidade: data.config.quantidade as 1 | 2 | 3,
      intervalo: data.config.intervalo,
      aceitar_qualquer: data.config.aceitar_qualquer,
      headless: data.config.headless,
      loop_continuo: data.config.loop_continuo,
      timer_duration_minutes: data.config.timer_duration_minutes,
      timer_start_time: data.config.timer_start_time,
      timer_end_time: data.config.timer_end_time,
      timer_loop_run_minutes: data.config.timer_loop_run_minutes,
      timer_loop_pause_minutes: data.config.timer_loop_pause_minutes,
    };

    await localDb.write(db);
    return { ok: true };
  });

// ─── Set Status ───────────────────────────────────────────────────────────────

export const setStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; status: string }) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["monitorando", "pausado", "concluido", "expirado"]),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const evIndex = db.events.findIndex(
      (e) => e.id === data.id && e.user_id === context.userId,
    );
    if (evIndex === -1) throw new Error("Event not found");

    db.events[evIndex].status = data.status as any;

    const cmd = data.status === "monitorando" ? "start" : "stop";
    db.bot_commands.push({
      id: crypto.randomUUID(),
      event_id: data.id,
      user_id: context.userId,
      command: cmd,
      created_at: new Date().toISOString(),
      processed_at: null,
    });

    await localDb.write(db);
    return { ok: true };
  });

// ─── Enqueue Command ──────────────────────────────────────────────────────────

export const enqueueCommand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; command: string }) =>
    z
      .object({
        id: z.string().uuid(),
        command: z.enum(["start", "stop", "test_login"]),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    db.bot_commands.push({
      id: crypto.randomUUID(),
      event_id: data.id,
      user_id: context.userId,
      command: data.command as "start" | "stop" | "test_login",
      created_at: new Date().toISOString(),
      processed_at: null,
    });
    await localDb.write(db);
    return { ok: true };
  });

// ─── Sanitize Config (strips secret fields for client) ────────────────────────

function sanitizeConfig(c: Record<string, unknown> | Partial<any>) {
  return {
    account_id: (c.account_id as string) ?? "",
    email: (c.email as string) ?? "",
    hasPassword: Boolean(c.senha_enc),
    setores: (c.setores as string[]) ?? [],
    quantidade: (c.quantidade as number) ?? 1,
    intervalo: (c.intervalo as number) ?? 30,
    aceitar_qualquer: Boolean(c.aceitar_qualquer),
    headless: c.headless !== false,
    loop_continuo: Boolean(c.loop_continuo),
    login_type: c.login_type as "normal" | "fla_id" | undefined,
    timer_duration_minutes: c.timer_duration_minutes as number | undefined,
    timer_start_time: c.timer_start_time as string | undefined,
    timer_end_time: c.timer_end_time as string | undefined,
    timer_loop_run_minutes: c.timer_loop_run_minutes as number | undefined,
    timer_loop_pause_minutes: c.timer_loop_pause_minutes as number | undefined,
  };
}
