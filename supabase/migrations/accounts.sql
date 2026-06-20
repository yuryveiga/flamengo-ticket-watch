-- Tabela de contas FutebolCard salvas
-- Execute no SQL Editor do Supabase

create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null check (char_length(label) between 1 and 80),
  email       text not null check (char_length(email) between 3 and 255),
  senha_enc   text not null default '',
  created_at  timestamptz not null default now()
);

-- Usuário só vê as próprias contas
alter table public.accounts enable row level security;

create policy "accounts: user owns" on public.accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Índice de consulta
create index if not exists accounts_user_id_idx on public.accounts(user_id);
