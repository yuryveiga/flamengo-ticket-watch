import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getEventLogs, clearEventLogs } from "@/lib/logs.functions";
import { X, Trash2, Wifi } from "lucide-react";
import type { LogRecord, LogLevel } from "@/lib/local-db";

// ─── Log level styling ────────────────────────────────────────────────────────

const levelMeta: Record<LogLevel, { label: string; color: string; icon: string }> = {
  info:    { label: "INFO",    color: "text-blue-400",   icon: "ℹ" },
  wait:    { label: "WAIT",    color: "text-yellow-400", icon: "⏳" },
  warn:    { label: "WARN",    color: "text-orange-400", icon: "⚠" },
  error:   { label: "ERRO",    color: "text-red-400",    icon: "✖" },
  success: { label: "OK",      color: "text-emerald-400",icon: "✅" },
  api:     { label: "API",     color: "text-purple-400", icon: "⚡" },
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Cart Alert banner ────────────────────────────────────────────────────────

function CartAlert({ log }: { log: LogRecord }) {
  return (
    <div className="mx-3 my-2 rounded-xl border-2 border-emerald-400 bg-emerald-950/60 p-4 animate-pulse">
      <p className="text-emerald-300 font-black text-lg text-center">🎟 INGRESSO NO CARRINHO!</p>
      <p className="text-emerald-200 text-sm text-center mt-1 break-words">{log.message}</p>
      <p className="text-emerald-400 text-xs text-center mt-2 font-semibold">
        Acesse o site AGORA e finalize o pagamento!
      </p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface LogsPanelProps {
  eventId: string;
  eventName: string;
  onClose: () => void;
}

export function LogsPanel({ eventId, eventName, onClose }: LogsPanelProps) {
  const qc = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [notified, setNotified] = useState(false);

  const getLogsFn = useServerFn(getEventLogs);
  const clearLogsFn = useServerFn(clearEventLogs);

  const { data: logs = [] } = useQuery({
    queryKey: ["logs", eventId],
    queryFn: () => getLogsFn({ data: { event_id: eventId, limit: 100 } }),
    refetchInterval: 2000,
  });

  const clearMutation = useMutation({
    mutationFn: () => clearLogsFn({ data: { event_id: eventId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["logs", eventId] }),
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  // Detect cart success and notify
  const cartLog = logs.find((l) => l.level === "success" && l.message.toLowerCase().includes("carrinho"));
  useEffect(() => {
    if (cartLog && !notified) {
      setNotified(true);
      // Browser notification
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("🎟 TicketBot — Ingresso no carrinho!", {
          body: cartLog.message,
          icon: "/favicon.ico",
        });
      } else if ("Notification" in window && Notification.permission !== "denied") {
        Notification.requestPermission().then((p) => {
          if (p === "granted") {
            new Notification("🎟 TicketBot — Ingresso no carrinho!", { body: cartLog.message });
          }
        });
      }
      // Audio beep via AudioContext
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.8);
      } catch {}
    }
  }, [cartLog, notified]);

  // Reset notified when logs are cleared
  useEffect(() => {
    if (logs.length === 0) setNotified(false);
  }, [logs.length]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed top-0 right-0 z-50 h-full w-full max-w-xl bg-[#0d1117] border-l border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-emerald-400 animate-pulse" />
            <span className="font-black text-sm truncate max-w-[220px]">
              Logs: {eventName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoScroll((v) => !v)}
              title={autoScroll ? "Auto-scroll ativo" : "Auto-scroll desativado"}
              className={`px-2 py-1 rounded text-xs font-mono ${autoScroll ? "bg-emerald-800 text-emerald-300" : "bg-accent text-muted-foreground"}`}
            >
              AUTO
            </button>
            <button
              onClick={() => clearMutation.mutate()}
              className="p-1.5 rounded hover:bg-accent"
              title="Limpar logs"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-accent">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Cart Alert */}
        {cartLog && <CartAlert log={cartLog} />}

        {/* Log Lines */}
        <div
          className="flex-1 overflow-y-auto font-mono text-xs p-3 space-y-0.5"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setAutoScroll(atBottom);
          }}
        >
          {logs.length === 0 && (
            <p className="text-muted-foreground text-center py-10">
              Nenhum log ainda. Inicie o bot para ver a atividade aqui.
            </p>
          )}
          {logs.map((log) => {
            const meta = levelMeta[log.level] ?? levelMeta.info;
            return (
              <div key={log.id} className="flex gap-2 leading-5">
                <span className="text-muted-foreground shrink-0">{fmtTime(log.ts)}</span>
                <span className={`${meta.color} shrink-0 w-4`}>{meta.icon}</span>
                <span className="text-zinc-300 break-words flex-1">{log.message}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border shrink-0 text-xs text-muted-foreground">
          {logs.length} linha{logs.length !== 1 ? "s" : ""} · atualiza a cada 2s
        </div>
      </div>
    </>
  );
}
