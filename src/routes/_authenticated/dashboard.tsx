import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listEvents, enqueueCommand, setStatus } from "@/lib/events.functions";
import { getEventLogs, clearEventLogs } from "@/lib/logs.functions";
import { toast } from "sonner";
import { Play, Square, Trash2, Download } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — TicketBot" }] }),
  component: Dashboard,
});

type EventRow = Awaited<ReturnType<typeof listEvents>>[number];

function Dashboard() {
  const listEventsFn = useServerFn(listEvents);
  const enqueueCommandFn = useServerFn(enqueueCommand);
  const setStatusFn = useServerFn(setStatus);

  const { data: events = [], refetch } = useQuery({
    queryKey: ["events"],
    queryFn: () => listEventsFn(),
    refetchInterval: 3000,
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId && events.length) setActiveId(events[0].id);
  }, [events, activeId]);

  const active = useMemo(() => events.find((e) => e.id === activeId), [events, activeId]);

  return (
    <div className="p-2 sm:p-4 md:p-6 space-y-2 sm:space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg sm:text-2xl font-black">Dashboard</h1>
        {events.length > 0 && (
          <select
            value={activeId ?? ""}
            onChange={(e) => setActiveId(e.target.value)}
            className="px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-md bg-card border border-border text-xs sm:text-sm max-w-[200px] sm:max-w-none truncate"
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
        <div className="grid lg:grid-cols-2 gap-2 sm:gap-4">
          <StatusPanel
            key={active.id}
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

      <SuccessBanner eventIds={events.map((e) => e.id)} events={events} />
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
  const getLogsFn = useServerFn(getEventLogs);
  const { data: statLogs = [] } = useQuery({
    queryKey: ["logs", event.id],
    queryFn: () => getLogsFn({ data: { event_id: event.id, limit: 200 } }),
    refetchInterval: 2000,
  });

  // ── Melhoria 6: Contador de tentativas e tempo ativo (Lendo do DB Local) ────────────────────────
  const attemptCount = (event as any).stats?.attempts || 0;
  const anomalousCount = (event as any).stats?.anomalous_responses || 0;
  const startedAtTs = (event as any).stats?.started_at || null;
  const [elapsed, setElapsed] = useState("00:00");
  useEffect(() => {
    if (!isRunning || !startedAtTs) { setElapsed("00:00"); return; }
    const tick = () => {
      const s = Math.floor((Date.now() - startedAtTs) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
      const ss = (s % 60).toString().padStart(2, "0");
      setElapsed(h > 0 ? `${h}:${m}:${ss}` : `${m}:${ss}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, startedAtTs]);

  // ── Melhoria 5: Setor sendo verificado agora ──────────────────────────────
  const lastLog = statLogs[statLogs.length - 1];
  const currentSectorMatch = lastLog?.message.match(/Procurando setor: "(.+?)"/);
  const currentSector = currentSectorMatch ? currentSectorMatch[1] : null;
  const lastCheck =
    statLogs.length > 0
      ? new Date(statLogs[statLogs.length - 1].ts).toLocaleTimeString("pt-BR")
      : "—";

  return (
    <section className="rounded-xl border border-border bg-card p-3 md:p-5 space-y-2 md:space-y-4">
      {/* ── MOBILE: Linha superior compacta (Status + Botões inline) ── */}
      <div className="flex items-center justify-between gap-2 md:hidden">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${color} ${isRunning ? "animate-pulse" : ""}`} />
          <span className="font-bold uppercase text-xs shrink-0">
            {isRunning ? "Ativo" : event.status === "expirado" ? "Expirado" : "Parado"}
          </span>
          {isRunning && currentSector && (
            <span className="text-[10px] bg-sky-900/50 text-sky-300 border border-sky-700 rounded px-1.5 py-0.5 animate-pulse truncate max-w-[120px]">
              🔍 {currentSector}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning ? (
            <button
              onClick={onStop}
              className="py-1 px-3 rounded-md bg-red-600 hover:bg-red-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow"
            >
              <Square className="h-3.5 w-3.5" />
              <span>Parar</span>
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={event.status === "expirado"}
              className="py-1 px-3 rounded-md bg-green-600 hover:bg-green-700 text-white font-bold text-xs disabled:opacity-40 flex items-center justify-center gap-1.5 shadow"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Iniciar</span>
            </button>
          )}
          <button
            onClick={onTest}
            className="py-1 px-2.5 rounded-md border border-border font-semibold text-xs hover:bg-accent"
          >
            Testar
          </button>
        </div>
      </div>

      {/* ── DESKTOP: Header original ── */}
      <div className="hidden md:flex items-center gap-2">
        <span className={`h-3 w-3 rounded-full ${color} ${isRunning ? "animate-pulse" : ""}`} />
        <span className="font-bold uppercase text-sm">
          {isRunning ? "Ativo" : event.status === "expirado" ? "Expirado" : "Parado"}
        </span>
        {isRunning && currentSector && (
          <span className="ml-auto text-xs bg-sky-900/50 text-sky-300 border border-sky-700 rounded px-2 py-0.5 animate-pulse">
            🔍 {currentSector}
          </span>
        )}
      </div>

      {/* ── MOBILE: Evento compacto ── */}
      <div className="md:hidden text-[11px] truncate flex items-center gap-1.5 bg-background/60 px-2 py-1 rounded border border-border/50">
        <span className="text-[10px] uppercase text-muted-foreground font-semibold shrink-0">Evento:</span>
        <span className="font-semibold text-foreground truncate">{event.name || event.url}</span>
      </div>

      {/* ── DESKTOP: Evento original ── */}
      <div className="hidden md:block">
        <p className="text-xs text-muted-foreground">Evento</p>
        <p className="font-semibold break-all">{event.name || event.url}</p>
      </div>

      {/* ── MOBILE: Stats compactos (4 colunas) ── */}
      <div className="grid grid-cols-4 md:hidden gap-1">
        <Stat label="Setor" value={event.config.setores[0] || "—"} />
        <Stat label="Qtd" value={String(event.config.quantidade)} />
        <Stat label="Tempo" value={isRunning ? elapsed : "—"} />
        <Stat label="Tentativas" value={isRunning ? String(attemptCount) : "—"} />
      </div>

      {/* ── DESKTOP: Stats originais (3 colunas com padding normal) ── */}
      <div className="hidden md:grid md:grid-cols-3 gap-3">
        <Stat label="Setor alvo" value={event.config.setores[0] || "—"} />
        <Stat label="Quantidade" value={String(event.config.quantidade)} />
        <Stat label="Respostas Anômalas" value={String(anomalousCount)} />
        <Stat label="Tentativas" value={isRunning ? String(attemptCount) : "—"} />
        <Stat label="Tempo ativo" value={isRunning ? elapsed : "—"} />
      </div>

      {/* ── DESKTOP: Botões de ação originais embaixo ── */}
      <div className="hidden md:flex gap-2 flex-wrap">
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

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`rounded-md bg-background border border-border p-1.5 md:p-2 text-center md:text-left ${className}`}>
      <p className="text-[9px] md:text-[10px] uppercase text-muted-foreground truncate">{label}</p>
      <p className="text-xs md:text-base font-bold truncate">{value}</p>
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

export function LogTerminal({ eventId }: { eventId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const getLogsFn = useServerFn(getEventLogs);

  const { data: logs = [] } = useQuery({
    queryKey: ["logs", eventId],
    queryFn: () => getLogsFn({ data: { event_id: eventId, limit: 200 } }),
    refetchInterval: 1000,
  });

  const clearLogsFn = useServerFn(clearEventLogs);

  const clear = async () => {
    await clearLogsFn({ data: { event_id: eventId } });
  };

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs]);

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
      className="rounded-xl border border-border overflow-hidden flex flex-col flex-1"
      style={{ background: "#0d1117" }}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 sm:px-3 sm:py-2 border-b border-border">
        <h3 className="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-white/70">
          Terminal · realtime
        </h3>
        <div className="flex gap-1">
          <button onClick={clear} title="Limpar logs" className="text-xs p-1 text-white/70 hover:text-white rounded hover:bg-white/10">
            <Trash2 className="h-3 w-3" />
          </button>
          <button onClick={exportTxt} title="Exportar logs" className="text-xs p-1 text-white/70 hover:text-white rounded hover:bg-white/10">
            <Download className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        ref={ref}
        className="font-mono text-[13px] md:text-xs p-2.5 md:p-3 overflow-auto h-[calc(100dvh-260px)] min-h-[220px] md:h-[400px]"
        style={{ fontFamily: "'JetBrains Mono','Fira Code',ui-monospace,monospace" }}
      >
        {logs.length === 0 ? (
          <p className="text-white/40 text-xs">— sem logs ainda —</p>
        ) : (
          logs.map((l) => (
            <div key={l.id} className={`${LEVEL_COLOR[l.level] ?? "text-white/70"} leading-normal py-0.5 break-words`}>
              <span className="opacity-60 text-[11px] md:text-xs font-sans">[{new Date(l.ts).toLocaleTimeString()}]</span> {LEVEL_EMOJI[l.level] ?? "⚪"} {l.message}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SuccessBanner({ eventIds, events }: { eventIds: string[]; events: EventRow[] }) {
  const getLogsFn = useServerFn(getEventLogs);
  const [result, setResult] = useState<{
    setor: string | null;
    quantidade: number | null;
    email?: string;
    url?: string;
  } | null>(null);
  const seenLogIds = useRef(new Set<string>());

  // ── Melhoria 7: Som real via AudioContext (880Hz por 1.5s) ───────────────
  function playSuccessSound() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.3);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.6);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 1.5);
    } catch { /* ignore */ }
  }

  // Faz polling nos logs de todos os eventos buscando mensagens de sucesso no carrinho
  useQuery({
    queryKey: ["banner-success", eventIds.join(",")],
    queryFn: async () => {
      for (const id of eventIds) {
        const logs = await getLogsFn({ data: { event_id: id, limit: 50 } });
        for (const l of logs) {
          if (
            l.level === "success" &&
            l.message.toLowerCase().includes("carrinho") &&
            !seenLogIds.current.has(l.id)
          ) {
            seenLogIds.current.add(l.id);
            const ev = events.find((e) => e.id === id);
            // ── Melhoria 7: Extrair setor e quantidade do log ─────────────────
            const setorMatch = l.message.match(/Setor: "(.+?)"/);
            const qtdMatch = l.message.match(/· (\d+)x/);
            const emailMatch = l.message.match(/\(Conta: (.+?)\)/);
            setResult({
              setor: setorMatch?.[1] ?? null,
              quantidade: qtdMatch ? parseInt(qtdMatch[1]) : null,
              email: emailMatch?.[1] || (ev?.config as any)?.email,
              url: ev?.url,
            });
            playSuccessSound();
            if (typeof Notification !== "undefined" && Notification.permission === "granted")
              new Notification("✅ Ingresso adicionado ao carrinho!");
            return null;
          }
        }
      }
      return null;
    },
    refetchInterval: 2000,
    enabled: eventIds.length > 0 && !result,
  });

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
