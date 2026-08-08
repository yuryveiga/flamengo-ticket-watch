import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { encryptText } from "./crypto.server";
import { localDb } from "./local-db";

// ─── List ─────────────────────────────────────────────────────────────────────
export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await localDb.read();
    const data = db.accounts
      .filter(a => a.user_id === context.userId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return data;
  });

// ─── Create ───────────────────────────────────────────────────────────────────
export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        label: z.string().min(1).max(80),
        email: z.string().email().max(255),
        senha: z.string().min(6).max(255),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const userAccounts = db.accounts.filter(a => a.user_id === context.userId);
    if (userAccounts.length >= 20) throw new Error("Limite de 20 contas atingido.");

    const senha_enc = await encryptText(data.senha);
    const newAccount = {
      id: crypto.randomUUID(),
      user_id: context.userId,
      label: data.label,
      email: data.email,
      senha_enc,
      created_at: new Date().toISOString()
    };
    
    db.accounts.push(newAccount);
    await localDb.write(db);
    
    return {
      id: newAccount.id,
      label: newAccount.label,
      email: newAccount.email,
      created_at: newAccount.created_at
    };
  });

// ─── Update ───────────────────────────────────────────────────────────────────
export const updateAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        label: z.string().min(1).max(80),
        email: z.string().email().max(255),
        senha: z.string().max(255).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    const accIndex = db.accounts.findIndex(a => a.id === data.id && a.user_id === context.userId);
    if (accIndex === -1) throw new Error("Account not found");
    
    db.accounts[accIndex].label = data.label;
    db.accounts[accIndex].email = data.email;
    if (data.senha) {
      db.accounts[accIndex].senha_enc = await encryptText(data.senha);
    }

    await localDb.write(db);
    return { ok: true };
  });

// ─── Delete ───────────────────────────────────────────────────────────────────
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const db = await localDb.read();
    db.accounts = db.accounts.filter(a => !(a.id === data.id && a.user_id === context.userId));
    await localDb.write(db);
    return { ok: true };
  });

// ─── Test All Logins ──────────────────────────────────────────────────────────
export const enqueueTestAllLoginsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await localDb.read();
    
    // Deleta comandos de test_all_logins anteriores pendentes para este usuário
    db.bot_commands = db.bot_commands.filter(
      (c) => !(c.command === "test_all_logins" && c.user_id === context.userId)
    );
    
    db.bot_commands.push({
      id: crypto.randomUUID(),
      event_id: "test-all-logins",
      user_id: context.userId,
      command: "test_all_logins",
      created_at: new Date().toISOString(),
      processed_at: null,
    });
    
    await localDb.write(db);
    return { ok: true };
  });
