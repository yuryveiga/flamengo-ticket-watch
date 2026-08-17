import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listEvents, createEvent, deleteEvent, setStatus, updateConfig, updateEvent } from "@/lib/events.functions";
import { listAccounts } from "@/lib/accounts.functions";
import { toast } from "sonner";
import {
  Trash2, Play, Pause, ClipboardList, Plus, ChevronRight, ChevronLeft,
  GripVertical, Check, Link2, Ticket, Users, MapPin, ExternalLink, Pencil
} from "lucide-react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LogsPanel } from "@/components/LogsPanel";

export const Route = createFileRoute("/_authenticated/eventos")({
  head: () => ({ meta: [{ title: "Eventos — TicketBot" }] }),
  component: EventosPage,
});

// ─── Maracanã sectors ─────────────────────────────────────────────────────────

const SETORES_PADRAO = [
  // Setores Norte
  "Norte Nível 1 | E",    "Norte Nível 2 | E",
  "Norte Nível 1 | F",    "Norte Nível 2 | F",
  "Norte Inferior",       "Norte Superior",
  // Setores Sul
  "Sul Nível 1 | C",      "Sul Nível 2 | C",
  "Sul Nível 1 | B",      "Sul Nível 2 | B",
  "Sul Inferior",         "Sul Superior",
  // Setores Leste / Oeste
  "Leste Superior",       "Leste Inferior",
  "Oeste Superior",
  // Outros (SEM Oeste Inferior e SEM Maracanã +)
  "Cadeira Especial Leste","Cadeira Especial Oeste",
  "Cadeira Cativa",
];

// ─── Status badge ─────────────────────────────────────────────────────────────

const statusMeta = {
  monitorando: { label: "Monitorando", color: "bg-emerald-600" },
  pausado:     { label: "Pausado",     color: "bg-zinc-600" },
  concluido:   { label: "Concluído",   color: "bg-blue-600" },
  expirado:    { label: "Expirado",    color: "bg-red-700" },
} as const;

// ─── Wizard state ─────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4;

interface WizardData {
  login_url: string;
  url: string;
  name: string;
  account_id: string;
  quantidade: 1 | 2 | 3;
  setores: string[];
  aceitar_qualquer: boolean;
  headless: boolean;
  intervalo: number;
  loop_continuo: boolean;
  timer_duration_minutes: number;
  timer_start_time: string;
  timer_end_time: string;
  timer_loop_run_minutes: number;
  timer_loop_pause_minutes: number;
}

const defaultWizard: WizardData = {
  login_url: "",
  url: "",
  name: "",
  account_id: "",
  quantidade: 1,
  setores: [],
  aceitar_qualquer: false,
  headless: true,
  intervalo: 10,
  loop_continuo: false,
  timer_duration_minutes: 0,
  timer_start_time: "",
  timer_end_time: "",
  timer_loop_run_minutes: 0,
  timer_loop_pause_minutes: 0,
};

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepDots({ step }: { step: WizardStep }) {
  const steps = [
    { n: 1, icon: <Link2 className="h-3.5 w-3.5" />, label: "URLs" },
    { n: 2, icon: <Users className="h-3.5 w-3.5" />, label: "Conta" },
    { n: 3, icon: <MapPin className="h-3.5 w-3.5" />, label: "Setores" },
    { n: 4, icon: <Play className="h-3.5 w-3.5" />, label: "Agendamento" },
  ];
  return (
    <div className="flex items-center gap-2 justify-center">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${step >= s.n ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground"}`}>
            {s.icon} {s.label}
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px w-6 ${step > s.n ? "bg-primary" : "bg-border"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Sortable sector item ─────────────────────────────────────────────────────

function SortableItem({ id, index, onRemove }: { id: string; index: number; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 ${isDragging ? "border-primary bg-primary/5 shadow-lg z-10" : "border-border bg-background"}`}
    >
      <button {...listeners} className="cursor-grab active:cursor-grabbing touch-none p-0.5 text-muted-foreground" aria-label="Arrastar">
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex items-center justify-center h-5 w-5 rounded-full bg-primary text-primary-foreground text-[10px] font-black shrink-0">
        {index + 1}
      </span>
      <span className="flex-1 text-sm">{id}</span>
      <span className="flex items-center gap-1 text-xs text-emerald-500 font-medium">
        <Check className="h-3 w-3" /> ativo
      </span>
      <button onClick={onRemove} className="ml-1 text-xs text-muted-foreground hover:text-red-500 px-1" aria-label={`Desativar ${id}`}>✕</button>
    </li>
  );
}

// ─── Wizard component ─────────────────────────────────────────────────────────

function EventWizard({ event, onCreated, onCancel }: { event?: any, onCreated: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<WizardStep>(1);
  const [data, setData] = useState<WizardData>(event ? {
    login_url: event.login_url,
    url: event.url,
    name: event.name || "",
    account_id: event.config?.account_id || "",
    quantidade: event.config?.quantidade || 1,
    setores: event.config?.setores || [],
    aceitar_qualquer: event.config?.aceitar_qualquer || false,
    headless: event.config?.headless ?? true,
    intervalo: event.config?.intervalo || 30,
    loop_continuo: event.config?.loop_continuo || false,
    timer_duration_minutes: event.config?.timer_duration_minutes || 0,
    timer_start_time: event.config?.timer_start_time || "",
    timer_end_time: event.config?.timer_end_time || "",
    timer_loop_run_minutes: event.config?.timer_loop_run_minutes || 0,
    timer_loop_pause_minutes: event.config?.timer_loop_pause_minutes || 0,
  } : defaultWizard);
  const [creating, setCreating] = useState(false);
  const [novoSetor, setNovoSetor] = useState("");
  const qc = useQueryClient();

  const listAccountsFn = useServerFn(listAccounts);
  const createEventFn = useServerFn(createEvent);
  const updateEventFn = useServerFn(updateEvent);
  const updateConfigFn = useServerFn(updateConfig);
  const setStatusFn = useServerFn(setStatus);

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => listAccountsFn(),
  });

  const set = useCallback(<K extends keyof WizardData>(key: K, val: WizardData[K]) => {
    setData((d) => ({ ...d, [key]: val }));
  }, []);

  const ativar = (s: string) => {
    if (!data.setores.includes(s)) set("setores", [...data.setores, s]);
  };
  const desativar = (s: string) => set("setores", data.setores.filter((x) => x !== s));
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldI = data.setores.indexOf(String(active.id));
    const newI = data.setores.indexOf(String(over.id));
    set("setores", arrayMove(data.setores, oldI, newI));
  };
  const addCustom = () => {
    const v = novoSetor.trim();
    if (!v || data.setores.includes(v)) return;
    set("setores", [...data.setores, v]);
    setNovoSetor("");
  };
  const disponiveis = SETORES_PADRAO.filter((s) => !data.setores.includes(s));

  const handleCreate = async () => {
    if (data.setores.length === 0 && !data.aceitar_qualquer) {
      toast.error("Selecione ao menos um setor ou marque 'Aceitar qualquer setor'.");
      return;
    }
    setCreating(true);
    try {
      let evId = event?.id;
      if (evId) {
        await updateEventFn({ data: { id: evId, login_url: data.login_url, url: data.url, name: data.name || undefined } });
      } else {
        const ev = await createEventFn({ data: { login_url: data.login_url, url: data.url, name: data.name || undefined } });
        evId = ev.id;
      }

      const selectedAccount = accounts.find((a) => a.id === data.account_id);
      await updateConfigFn({
        data: {
          id: evId,
          config: {
            account_id: data.account_id,
            email: data.account_id === "ALL" ? "TODAS" : (selectedAccount?.email ?? ""),
            senha: "",
            setores: data.setores,
            quantidade: data.quantidade,
            intervalo: data.intervalo,
            aceitar_qualquer: data.aceitar_qualquer,
            headless: data.headless,
            loop_continuo: data.loop_continuo,
            timer_duration_minutes: data.timer_duration_minutes || undefined,
            timer_start_time: data.timer_start_time || undefined,
            timer_end_time: data.timer_end_time || undefined,
            timer_loop_run_minutes: data.timer_loop_run_minutes || undefined,
            timer_loop_pause_minutes: data.timer_loop_pause_minutes || undefined,
          },
        },
      });

      if (!event) {
        await setStatusFn({ data: { id: evId, status: "monitorando" } });
        toast.success("Evento criado e bot iniciado!");
      } else {
        toast.success("Evento atualizado!");
      }

      qc.invalidateQueries({ queryKey: ["events"] });
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar evento");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-black text-base">{event ? "Editar Evento" : "Novo Evento"}</h2>
        <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">Cancelar</button>
      </div>

      <StepDots step={step} />

      {/* ── Step 1: URLs ──────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">URL de Login <span className="text-red-400">*</span></label>
            <input
              type="url"
              required
              value={data.login_url}
              onChange={(e) => set("login_url", e.target.value)}
              placeholder="https://www.futebolcard.com/login"
              className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">Página onde o bot vai se autenticar</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">URL do Evento <span className="text-red-400">*</span></label>
            <input
              type="url"
              required
              value={data.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="https://www.futebolcard.com/buy/sector?event=..."
              className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">Página de compra/seleção de setores</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Nome do evento (opcional)</label>
            <input
              value={data.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Ex: Flamengo x Vasco — Brasileirão"
              maxLength={120}
              className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
            />
          </div>
          <button
            disabled={!data.login_url || !data.url}
            onClick={() => setStep(2)}
            className="w-full py-2.5 rounded-md bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
          >
            Próxima <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Step 2: Account & qty ────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Conta a utilizar <span className="text-red-400">*</span></label>
            {accounts.length === 0 ? (
              <p className="mt-2 text-xs text-yellow-400">⚠ Nenhuma conta cadastrada. Vá até a aba Contas e adicione uma primeiro.</p>
            ) : (
              <select
                value={data.account_id}
                onChange={(e) => set("account_id", e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
              >
                <option value="">— selecionar conta —</option>
                <option value="ALL">🌟 TODAS (rodar em sequência)</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label} · {a.email}</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Quantidade de ingressos</label>
            <div className="flex gap-2 mt-1">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => set("quantidade", n)}
                  className={`flex-1 py-2.5 rounded-md text-sm font-semibold transition-colors ${data.quantidade === n ? "bg-primary text-primary-foreground" : "border border-border hover:bg-accent"}`}
                >
                  {n} ingresso{n > 1 ? "s" : ""}
                </button>
              ))}
            </div>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground font-medium">Configurações avançadas</summary>
            <div className="mt-3 space-y-3">
              <label className="block text-xs">
                Intervalo entre tentativas: <span className="font-bold">{data.intervalo}s</span>
                <input type="range" min={5} max={60} step={5} value={data.intervalo} onChange={(e) => set("intervalo", Number(e.target.value))} className="w-full mt-1" />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={data.headless} onChange={(e) => set("headless", e.target.checked)} />
                Modo headless (browser invisível)
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={data.loop_continuo} onChange={(e) => set("loop_continuo", e.target.checked)} />
                Rodar continuamente (após processar as contas, recomeçar do início)
              </label>
            </div>
          </details>

          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className="flex-1 py-2.5 rounded-md border border-border font-semibold text-sm flex items-center justify-center gap-1">
              <ChevronLeft className="h-4 w-4" /> Voltar
            </button>
            <button
              disabled={!data.account_id}
              onClick={() => setStep(3)}
              className="flex-1 py-2.5 rounded-md bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-1 disabled:opacity-40"
            >
              Próxima <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Sectors ──────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Setores ativos — arraste para reordenar por prioridade</p>
            {data.setores.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-2">Nenhum setor ativo — ative abaixo ou marque "aceitar qualquer".</p>
            ) : (
              <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={data.setores} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-1.5">
                    {data.setores.map((s, i) => (
                      <SortableItem key={s} id={s} index={i} onRemove={() => desativar(s)} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
          </div>

          {disponiveis.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Disponíveis — clique para ativar</p>
              <div className="flex flex-wrap gap-1.5">
                {disponiveis.map((s) => (
                  <button
                    key={s}
                    onClick={() => ativar(s)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-dashed border-border text-xs hover:border-primary hover:text-primary transition-colors"
                  >
                    <Plus className="h-3 w-3" /> {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={novoSetor}
              onChange={(e) => setNovoSetor(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())}
              placeholder="Setor personalizado..."
              maxLength={120}
              className="flex-1 px-3 py-2 rounded-md bg-background border border-border text-sm"
            />
            <button onClick={addCustom} className="px-3 py-2 rounded-md bg-accent text-sm font-semibold">
              + Add
            </button>
          </div>

          <div>
            <label className="text-sm font-semibold flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={data.aceitar_qualquer} onChange={(e) => set("aceitar_qualquer", e.target.checked)} />
              Se meus setores não estiverem disponíveis, comprar QUALQUER SETOR que aparecer.
            </label>
          </div>

          <div className="flex gap-2">
            <button onClick={() => setStep(2)} className="flex-1 py-2.5 rounded-md border border-border font-semibold text-sm flex items-center justify-center gap-1">
              <ChevronLeft className="h-4 w-4" /> Voltar
            </button>
            <button
              disabled={data.setores.length === 0 && !data.aceitar_qualquer}
              onClick={() => setStep(4)}
              className="flex-1 py-2.5 rounded-md bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-1 disabled:opacity-40"
            >
              Próxima <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Scheduling & Timers ───────────────────────── */}
      {step === 4 && (
        <div className="space-y-6">
          
          <div className="space-y-4">
            <h3 className="text-sm font-bold border-b border-border pb-2">1. Janela de Horário (Opcional)</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Início Automático</label>
                <input
                  type="time"
                  value={data.timer_start_time}
                  onChange={(e) => set("timer_start_time", e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">O bot só ligará após esse horário.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Término Automático</label>
                <input
                  type="time"
                  value={data.timer_end_time}
                  onChange={(e) => set("timer_end_time", e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">O bot desligará ao chegar nesse horário.</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-bold border-b border-border pb-2">2. Duração Absoluta (Opcional)</h3>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Desligar automaticamente após (minutos)</label>
              <input
                type="number"
                min="0"
                value={data.timer_duration_minutes || ""}
                onChange={(e) => set("timer_duration_minutes", Number(e.target.value))}
                placeholder="Ex: 120 (para 2 horas)"
                className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">Útil para evitar esquecer o bot ligado gastando CPU.</p>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-bold border-b border-border pb-2">3. Prevenção de Ban (Descanso / Loop)</h3>
            <p className="text-xs text-muted-foreground">Simula um comportamento humano desligando o navegador periodicamente.</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Rodar por (minutos)</label>
                <input
                  type="number"
                  min="0"
                  value={data.timer_loop_run_minutes || ""}
                  onChange={(e) => set("timer_loop_run_minutes", Number(e.target.value))}
                  placeholder="Ex: 45"
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Pausar por (minutos)</label>
                <input
                  type="number"
                  min="0"
                  value={data.timer_loop_pause_minutes || ""}
                  onChange={(e) => set("timer_loop_pause_minutes", Number(e.target.value))}
                  placeholder="Ex: 15"
                  className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={() => setStep(3)} className="flex-1 py-2.5 rounded-md border border-border font-semibold text-sm flex items-center justify-center gap-1">
              <ChevronLeft className="h-4 w-4" /> Voltar
            </button>
            <button
              disabled={creating}
              onClick={handleCreate}
              className="flex-1 py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40 transition-colors"
            >
              <Play className="h-4 w-4" />
              {creating ? "Salvando..." : (event ? "Salvar Alterações" : "Salvar e Iniciar")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function EventosPage() {
  const qc = useQueryClient();
  const [editingEvent, setEditingEvent] = useState<any>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [logsPanel, setLogsPanel] = useState<{ id: string; name: string } | null>(null);

  const listEventsFn  = useServerFn(listEvents);
  const deleteEventFn = useServerFn(deleteEvent);
  const setStatusFn   = useServerFn(setStatus);

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["events"],
    queryFn: () => listEventsFn(),
    refetchInterval: 5000,
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, current }: { id: string; current: string }) =>
      setStatusFn({ data: { id, status: current === "monitorando" ? "pausado" : "monitorando" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const removeEvent = useMutation({
    mutationFn: (id: string) => deleteEventFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      toast.success("Evento removido");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">Eventos</h1>
          <p className="text-sm text-muted-foreground">Gerencie e monitore os eventos do Maracanã</p>
        </div>
        {!showWizard && !editingEvent && (
          <button
            onClick={() => setShowWizard(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground font-semibold text-sm"
          >
            <Plus className="h-4 w-4" /> Novo Evento
          </button>
        )}
      </div>

      {/* Wizard */}
      {(showWizard || editingEvent) && (
        <EventWizard
          event={editingEvent}
          onCreated={() => { setShowWizard(false); setEditingEvent(null); }}
          onCancel={() => { setShowWizard(false); setEditingEvent(null); }}
        />
      )}

      {/* Event list */}
      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground text-sm">Carregando...</div>
      ) : events.length === 0 && !showWizard && !editingEvent ? (
        <div className="py-16 border border-dashed border-border rounded-xl text-center space-y-3">
          <Ticket className="h-10 w-10 mx-auto text-muted-foreground opacity-40" />
          <p className="text-muted-foreground">Nenhum evento cadastrado ainda.</p>
          <button
            onClick={() => setShowWizard(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-semibold"
          >
            <Plus className="h-4 w-4" /> Criar primeiro evento
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((ev) => {
            const meta = statusMeta[ev.status as keyof typeof statusMeta] ?? statusMeta.pausado;
            const isRunning = ev.status === "monitorando";
            const name = ev.name || (() => { try { return new URL(ev.url).hostname; } catch { return ev.url; } })();
            return (
              <div key={ev.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  {/* Main info */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold truncate">{name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full text-white font-medium ${meta.color}`}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1 truncate max-w-[200px]">
                        <Link2 className="h-3 w-3 shrink-0" /> {ev.login_url || ev.url}
                      </span>
                      {(ev.config as any)?.setores?.length > 0 && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {(ev.config as any).setores.slice(0, 2).join(", ")}
                          {(ev.config as any).setores.length > 2 && ` +${(ev.config as any).setores.length - 2}`}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Logs button */}
                    <button
                      onClick={() => setLogsPanel({ id: ev.id, name })}
                      title="Ver logs"
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                    >
                      <ClipboardList className="h-4 w-4 text-muted-foreground" />
                    </button>

                    {/* Edit button */}
                    <button
                      onClick={() => setEditingEvent(ev)}
                      title="Editar evento"
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>

                    {/* Open URL button */}
                    <a
                      href={ev.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir URL do evento"
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                    >
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </a>

                    {/* Play/Pause */}
                    <button
                      onClick={() => toggleStatus.mutate({ id: ev.id, current: ev.status })}
                      title={isRunning ? "Pausar" : "Iniciar"}
                      className={`p-2 rounded-md transition-colors ${isRunning ? "bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400" : "bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400"}`}
                    >
                      {isRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => {
                        if (confirm(`Remover "${name}"?`)) removeEvent.mutate(ev.id);
                      }}
                      title="Remover"
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Logs Panel */}
      {logsPanel && (
        <LogsPanel
          eventId={logsPanel.id}
          eventName={logsPanel.name}
          onClose={() => setLogsPanel(null)}
        />
      )}
    </div>
  );
}
