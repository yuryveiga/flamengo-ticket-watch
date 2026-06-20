# TicketBot — Plano

Escopo dividido em **2 entregas**:

## A) Painel web (Lovable Cloud) — construído aqui

### Stack
- TanStack Start + React + Tailwind + shadcn
- Lovable Cloud (Supabase): Postgres, Auth, Realtime
- Sidebar layout (Dashboard / Eventos / Histórico / Configurações)

### Schema do banco
```
events       (id, user_id, url, name, created_at, expires_at, status, config jsonb)
  status: monitorando | pausado | concluido | expirado
  config: { email, senha_enc, setores[], quantidade, intervalo, aceitar_qualquer, headless }

logs         (id, event_id, user_id, ts, level, message)
  level: info | success | warning | error | api | wait

results      (id, event_id, user_id, executed_at, setor, quantidade, status)

bot_commands (id, event_id, user_id, command, created_at, consumed_at)
  command: start | stop | test_login
  → fila que o bot externo lê via Realtime/REST
```
RLS em tudo escopado por `user_id`. Senha cifrada com AES-256 via server function (chave em secret `ENCRYPTION_KEY`).

### Páginas
1. **/login** — email+senha + Google
2. **/dashboard** — status do bot por evento ativo, terminal de logs realtime (auto-scroll, cores por level, export .txt), banner de sucesso quando `results` insert chega
3. **/eventos** — lista (badge dias restantes), form criar (URL, nome), abrir evento → config (email, senha c/ toggle, setores drag-drop, qtd, sliders avançados), botões Testar Login / Iniciar / Parar / Remover, limite 10
4. **/historico** — tabela `results`
5. **/configuracoes** — perfil + token API do bot (gerado para autenticar o repo externo)

### Server functions
- `events.*` — CRUD
- `encryptPassword` / `decryptPassword` (service-role, server-only)
- `enqueueBotCommand` — start/stop/test
- `getBotPayload` — devolve config descriptografada para o bot externo (rota `/api/public/bot/poll` autenticada por token)
- `pushLog` / `pushResult` — rota `/api/public/bot/log` (token)

### Realtime
Frontend assina `logs` e `results` filtrados por `event_id`.

### Cron
pg_cron diário: `UPDATE events SET status='expirado' WHERE expires_at < now()`.

## B) Repo do bot (entregue como artifact .zip)

Repo Node.js standalone para rodar em VPS:
```
ticketbot-worker/
  package.json (playwright, @supabase/supabase-js, dotenv)
  .env.example (SUPABASE_URL, BOT_TOKEN, PANEL_URL)
  src/index.ts       — loop principal, polling de comandos
  src/bot.ts         — Playwright: anti-detect, interceptação API, fallback DOM
  src/api.ts         — cliente REST do painel (poll, log, result)
  src/selectors.ts   — lista de seletores de botões
  README.md          — como rodar (npm i, npx playwright install, npm start)
```

Lógica do bot conforme brief: interceptação `page.on('response')` + polling 30s fallback, anti-detect (UA, flag, delays 800-2000ms, bloqueio assets), seletores em ordem, verificação sucesso por URL/modal.

## Implementação por fases (vou executar tudo em sequência)

**Fase 1 — Backend/DB**
- Habilitar Lovable Cloud
- Migration: tabelas + RLS + cron
- Secret `ENCRYPTION_KEY`
- Server functions crypto + CRUD events

**Fase 2 — Auth + Layout**
- Login/signup (email+Google)
- Sidebar, _authenticated layout, rotas

**Fase 3 — Eventos**
- Lista, form, página de config (drag-drop com @dnd-kit)

**Fase 4 — Dashboard + Realtime**
- Terminal logs, status cards, banner sucesso, som+notification

**Fase 5 — API pública para o bot**
- Rotas `/api/public/bot/poll`, `/log`, `/result` autenticadas por token

**Fase 6 — Repo do bot**
- Gerar zip em `/mnt/documents/ticketbot-worker.zip`

**Fase 7 — Histórico + polimento**

Dado o tamanho, vou executar tudo numa sequência longa sem pedir confirmação entre fases. Aviso parcialmente após cada fase via task list.