import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listEvents, enqueueCommand, setStatus } from "@/lib/events.functions";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Play, Square, Trash2, Download } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — TicketBot" }] }),
  component: Dashboard,
});

type LogRow = { id: number; ts: string; level: string; message: string };
type EventRow = Awaited<ReturnType<typeof listEvents>>[number];

function Dashboard() {
  const listEventsFn = useServerFn(listEvents);
  const enqueueCommandFn = useServerFn(enqueueCommand);
  const setStatusFn = useServerFn(setStatus);

  const { data: events = [], refetch } = useQuery({
    queryKey: ["events"],
    queryFn: () => listEventsFn(),
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId && events.length) setActiveId(events[0].id);
  }, [events, activeId]);

  const active = useMemo(() => events.find((e) => e.id === activeId), [events, activeId]);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-black">Dashboard</h1>
        {events.length > 0 && (
          <select
            value={activeId ?? ""}
            onChange={(e) => setActiveId(e.target.value)}
            className="px-3 py-1.5 rounded-md bg-card border border-border text-sm"
          >
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name || e.url.slice(0, 40)}
              </option>
            ))}
          </select>
        )}
      </div>

      {events.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border rounded-xl">
          <p className="text-muted-foreground">Nenhum evento cadastrado.</p>
          <Link
            to="/eventos"
            className="inline-block mt-3 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-semibold"
          >
            + Adicionar evento
          </Link>
        </div>
      ) : active ? (
        <div className="grid lg:grid-cols-2 gap-4">
          <StatusPanel
            event={active}
            onStart={async () => {
              try {
                await setStatusFn({ data: { id: active.id, status: "monitorando" } });
                refetch();
                toast.success("Bot iniciado");
              } catch (e: any) {
                toast.error(e.message);
              }
            }}
            onStop={async () => {
              try {
                await setStatusFn({ data: { id: active.id, status: "pausado" } });
                refetch();
                toast.success("Bot pausado");
              } catch (e: any) {
                toast.error(e.message);
              }
            }}
            onTest={async () => {
              try {
                await enqueueCommandFn({ data: { id: active.id, command: "test_login" } });
                toast.success("Comando de teste enviado");
              } catch (e: any) {
                toast.error(e.message);
              }
            }}
          />
          <LogTerminal eventId={active.id} />
        </div>
      ) : null}

      <SuccessBanner eventIds={events.map((e) => e.id)} />
    </div>
  );
}

function StatusPanel({
  event,
  onStart,
  onStop,
  onTest,
}: {
  event: EventRow;
  onStart: () => void;
  onStop: () => void;
  onTest: () => void;
}) {
  const isRunning = event.status === "monitorando";
  const color = isRunning
    ? "bg-green-500"
    : event.status === "expirado"
      ? "bg-red-500"
      : "bg-gray-500";
  const [checks, setChecks] = useState(0);
  const [lastCheck, setLastCheck] = useState<string>("—");

  useEffect(() => {
    const ch = supabase
      .channel(`logs-stat-${event.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "logs", filter: `event_id=eq.${event.id}` },
        (p) => {
          setChecks((c) => c + 1);
          setLastCheck(new Date((p.new as { ts: string }).ts).toLocaleTimeString());
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [event.id]);

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className={`h-3 w-3 rounded-full ${color} ${isRunning ? "animate-pulse" : ""}`} />
        <span className="font-bold uppercase text-sm">
          {isRunning ? "Ativo" : event.status === "expirado" ? "Expirado" : "Parado"}
        </span>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Evento</p>
        <p className="font-semibold break-all">{event.name || event.url}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Setor alvo" value={event.config.setores[0] || "—"} />
        <Stat label="Quantidade" value={String(event.config.quantidade)} />
        <Stat label="Verificações" value={String(checks)} />
        <Stat label="Último check" value={lastCheck} />
      </div>
      <div className="flex gap-2 flex-wrap">
        {isRunning ? (
          <button
            onClick={onStop}
            className="flex-1 py-3 rounded-md bg-red-600 text-white font-bold flex items-center justify-center gap-2"
          >
            <Square className="h-5 w-5" />
            Parar
          </button>
        ) : (
          <button
            onClick={onStart}
            disabled={event.status === "expirado"}
            className="flex-1 py-3 rounded-md bg-green-600 text-white font-bold disabled:opacity-40 flex items-center justify-center gap-2"
          >
            <Play className="h-5 w-5" />
            Iniciar
          </button>
        )}
        <button
          onClick={onTest}
          className="py-3 px-4 rounded-md border border-border font-semibold text-sm"
        >
          Testar Login
        </button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-background border border-border p-2">
      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
      <p className="font-bold truncate">{value}</p>
    </div>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  info: "text-sky-400",
  wait: "text-yellow-400",
  success: "text-green-400",
  error: "text-red-400",
  warning: "text-yellow-400",
  api: "text-cyan-400",
};
const LEVEL_EMOJI: Record<string, string> = {
  info: "🔵",
  wait: "🟡",
  success: "🟢",
  error: "🔴",
  warning: "🟠",
  api: "🩵",
};

function LogTerminal({ eventId }: { eventId: string }) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogs([]);
    supabase
      .from("logs")
      .select("id, ts, level, message")
      .eq("event_id", eventId)
      .order("ts", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (data) setLogs(data.reverse() as LogRow[]);
      });

    const ch = supabase
      .channel(`logs-${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "logs", filter: `event_id=eq.${eventId}` },
        (p) => setLogs((cur) => [...cur, p.new as LogRow].slice(-500)),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [eventId]);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs]);

  const clear = () => setLogs([]);
  const exportTxt = () => {
    const txt = logs
      .map((l) => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} — ${l.message}`)
      .join("\n");
    const blob = new Blob([txt], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${eventId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className="rounded-xl border border-border overflow-hidden flex flex-col"
      style={{ background: "#0d1117" }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-xs font-bold uppercase tracking-wider text-white/70">
          Terminal · realtime
        </h3>
        <div className="flex gap-1">
          <button onClick={clear} className="text-xs px-2 py-1 text-white/70 hover:text-white">
            <Trash2 className="h-3 w-3" />
          </button>
          <button onClick={exportTxt} className="text-xs px-2 py-1 text-white/70 hover:text-white">
            <Download className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        ref={ref}
        className="font-mono text-xs p-3 overflow-auto h-[400px]"
        style={{ fontFamily: "'JetBrains Mono','Fira Code',ui-monospace,monospace" }}
      >
        {logs.length === 0 ? (
          <p className="text-white/40">— sem logs ainda —</p>
        ) : (
          logs.map((l) => (
            <div key={l.id} className={LEVEL_COLOR[l.level] ?? "text-white/70"}>
              [{new Date(l.ts).toLocaleTimeString()}] {LEVEL_EMOJI[l.level] ?? "⚪"} {l.message}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SuccessBanner({ eventIds }: { eventIds: string[] }) {
  const [result, setResult] = useState<{
    setor: string | null;
    quantidade: number | null;
    email?: string;
    url?: string;
  } | null>(null);

  useEffect(() => {
    if (eventIds.length === 0) return;
    const ch = supabase
      .channel("results-banner")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "results" },
        async (p) => {
          const r = p.new as {
            event_id: string;
            setor: string | null;
            quantidade: number | null;
            status: string;
          };
          if (r.status !== "Sucesso" || !eventIds.includes(r.event_id)) return;
          const { data: ev } = await supabase
            .from("events")
            .select("config, url")
            .eq("id", r.event_id)
            .single();
          setResult({
            setor: r.setor,
            quantidade: r.quantidade,
            email: (ev?.config as { email?: string })?.email,
            url: ev?.url,
          });
          try {
            new Audio(
              "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
            )
              .play()
              .catch(() => {});
            if (typeof Notification !== "undefined" && Notification.permission === "granted")
              new Notification("✅ Ingresso adicionado ao carrinho!");
          } catch {
            /* ignore */
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [eventIds]);

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default")
      Notification.requestPermission().catch(() => {});
  }, []);

  if (!result) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-card border-2 border-green-500 rounded-xl p-6 max-w-md w-full space-y-4">
        <h2 className="text-2xl font-black text-green-500 text-center">✅ INGRESSO ADICIONADO!</h2>
        <div className="font-mono text-sm space-y-1 bg-background p-3 rounded">
          <div>🛒 No carrinho:</div>
          <div>Login : {result.email ?? "—"}</div>
          <div>Setor : {result.setor ?? "—"}</div>
          <div>Quantidade: {result.quantidade ?? "—"}</div>
        </div>
        <p className="text-sm text-muted-foreground text-center">
          Finalize o pagamento no browser agora.
        </p>
        <div className="flex gap-2">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="flex-1 py-2 rounded-md bg-primary text-primary-foreground font-bold text-center"
          >
            Abrir FutebolCard
          </a>
          <button
            onClick={() => setResult(null)}
            className="px-4 py-2 rounded-md border border-border"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
