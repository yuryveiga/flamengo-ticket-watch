
-- Events
CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  url TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pausado',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 days')
);
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own events all" ON public.events FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX events_user_idx ON public.events(user_id);

-- Logs
CREATE TABLE public.logs (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL
);
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own logs select" ON public.logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own logs insert" ON public.logs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX logs_event_ts_idx ON public.logs(event_id, ts DESC);

-- Results
CREATE TABLE public.results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  setor TEXT,
  quantidade INT,
  status TEXT NOT NULL
);
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own results select" ON public.results FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own results insert" ON public.results FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX results_event_idx ON public.results(event_id, executed_at DESC);

-- Bot commands queue
CREATE TABLE public.bot_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  command TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own commands all" ON public.bot_commands FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX bot_commands_event_idx ON public.bot_commands(event_id, created_at DESC);

-- Bot tokens (one per user, used by external worker to authenticate)
CREATE TABLE public.bot_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.bot_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own token select" ON public.bot_tokens FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own token insert" ON public.bot_tokens FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own token delete" ON public.bot_tokens FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX bot_tokens_token_idx ON public.bot_tokens(token);

-- Profiles (for display name etc)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile all" ON public.profiles FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.results;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bot_commands;
ALTER PUBLICATION supabase_realtime ADD TABLE public.events;

-- Cron: mark expired events as 'expirado' and pause them
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'expire-events-daily',
  '0 3 * * *',
  $$UPDATE public.events SET status='expirado' WHERE expires_at < now() AND status <> 'expirado'$$
);
