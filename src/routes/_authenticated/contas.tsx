import { createFileRoute } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  enqueueTestAllLoginsFn,
} from "@/lib/accounts.functions";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Eye, EyeOff, X, Check, ShieldCheck, Github, Play } from "lucide-react";
import { LogTerminal } from "./dashboard";

export const Route = createFileRoute("/_authenticated/contas")({
  head: () => ({ meta: [{ title: "Contas — TicketBot" }] }),
  component: ContasPage,
});

type Account = { id: string; label: string; email: string; login_type?: "normal" | "fla_id"; created_at: string };

// ─── Modal de criação / edição ────────────────────────────────────────────────
function AccountModal({ account, onClose }: { account?: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(account?.label ?? "");
  const [email, setEmail] = useState(account?.email ?? "");
  const [senha, setSenha] = useState("");
  const [loginType, setLoginType] = useState<"normal" | "fla_id">(account?.login_type ?? "normal");
  const [show, setShow] = useState(false);

  const createAccountFn = useServerFn(createAccount);
  const updateAccountFn = useServerFn(updateAccount);

  const create = useMutation({
    mutationFn: (d: { label: string; email: string; senha: string; login_type: "normal" | "fla_id" }) =>
      createAccountFn({ data: d }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Conta adicionada");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: (d: { id: string; label: string; email: string; senha: string; login_type: "normal" | "fla_id" }) =>
      updateAccountFn({ data: d }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Conta atualizada");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isEditing = Boolean(account);
  const loading = create.isPending || update.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !email.trim()) return;
    if (!isEditing && !senha) {
      toast.error("Senha obrigatória");
      return;
    }
    if (isEditing) {
      update.mutate({ id: account!.id, label, email, senha, login_type: loginType });
    } else {
      create.mutate({ label, email, senha, login_type: loginType });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-black text-lg">{isEditing ? "Editar conta" : "Nova conta"}</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground font-medium">Tipo de Conta</label>
            <div className="mt-1 grid grid-cols-2 gap-2 p-1 bg-background rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setLoginType("normal")}
                className={`py-2 text-xs font-bold rounded-md transition-all ${
                  loginType === "normal"
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                1 - Conta Normal
              </button>
              <button
                type="button"
                onClick={() => setLoginType("fla_id")}
                className={`py-2 text-xs font-bold rounded-md transition-all flex items-center justify-center gap-1.5 ${
                  loginType === "fla_id"
                    ? "bg-red-600 text-white shadow"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>🔴</span> 2 - FLA ID
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {loginType === "fla_id" 
                ? "Login através do botão 'Entrar com Fla-ID'."
                : "Login direto com e-mail/CPF e senha."}
            </p>
          </div>

          <div>
            <label className="text-xs text-muted-foreground font-medium">Apelido</label>
            <input
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex: Conta Principal, VIP 1…"
              className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium">
              {loginType === "fla_id" ? "E-mail ou CPF (Fla-ID)" : "E-mail FutebolCard"}
            </label>
            <input
              required
              type={loginType === "fla_id" ? "text" : "email"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={loginType === "fla_id" ? "E-mail ou CPF do Fla-ID" : "email@exemplo.com"}
              className="mt-1 w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium">
              Senha
              {isEditing && (
                <span className="ml-1 text-muted-foreground">(deixe vazio para manter)</span>
              )}
            </label>
            <div className="relative mt-1">
              <input
                type={show ? "text" : "password"}
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                minLength={isEditing ? 0 : 6}
                placeholder={isEditing ? "••••••••" : "Mínimo 6 caracteres"}
                className="w-full px-3 py-2 pr-10 rounded-md bg-background border border-border text-sm"
              />
              <button
                type="button"
                onClick={() => setShow(!show)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> Senha cifrada com AES-256 antes de ir ao banco.
            </p>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-md border border-border text-sm font-semibold"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? (
                "Salvando…"
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  {isEditing ? "Salvar" : "Adicionar"}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────
function ContasPage() {
  const qc = useQueryClient();
  const listAccountsFn = useServerFn(listAccounts);
  const deleteAccountFn = useServerFn(deleteAccount);
  const enqueueTestAll = useServerFn(enqueueTestAllLoginsFn);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => listAccountsFn(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAccountFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Conta removida");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [modal, setModal] = useState<"new" | Account | null>(null);
  const [showTestModal, setShowTestModal] = useState(false);

  const startTestAll = async () => {
    try {
      await enqueueTestAll();
      setShowTestModal(true);
      toast.success("Teste iniciado!");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const exportAccounts = () => {
    const safe = accounts.map(({ id, label, email, created_at }) => ({ id, label, email, created_at }));
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "contas-backup.json"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-black">Contas FutebolCard</h1>
          <p className="text-sm text-muted-foreground">
            Salve suas contas para reutilizar em vários eventos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {accounts.length > 0 && (
            <>
              <button
                onClick={startTestAll}
                title="Testar login de todas as contas sequencialmente"
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-border font-semibold text-sm hover:bg-accent"
              >
                <Play className="h-4 w-4" /> Testar Todos
              </button>
              <button
                onClick={exportAccounts}
                title="Exportar contas (sem senhas)"
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-border font-semibold text-sm hover:bg-accent"
              >
                <Download className="h-4 w-4" /> Exportar
              </button>
            </>
          )}
          <button
            onClick={() => setModal("new")}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground font-semibold text-sm shrink-0"
          >
            <Plus className="h-4 w-4" /> Nova conta
          </button>
        </div>
      </div>

      {/* GitHub backup hint */}
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card/50 p-3 text-xs text-muted-foreground">
        <Github className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-foreground">Backup no GitHub:</span> Commite o arquivo{" "}
          <code className="bg-accent px-1 py-0.5 rounded">local-data.json</code> em um repositório <strong>privado</strong>.{" "}
          As senhas estão criptografadas (AES-256) e seguras mesmo no repositório.
        </div>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground text-sm">Carregando…</div>
      ) : accounts.length === 0 ? (
        <div className="py-16 border border-dashed border-border rounded-xl text-center space-y-3">
          <p className="text-muted-foreground">Nenhuma conta salva ainda.</p>
          <button
            onClick={() => setModal("new")}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-semibold"
          >
            <Plus className="h-4 w-4" /> Adicionar primeira conta
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {accounts.map((acc) => (
            <li
              key={acc.id}
              className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card"
            >
              <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-primary font-bold text-sm">
                  {acc.label.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{acc.label}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-muted-foreground truncate">{acc.email}</p>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    acc.login_type === "fla_id"
                      ? "bg-red-500/15 text-red-500 border border-red-500/30"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {acc.login_type === "fla_id" ? "🔴 FLA ID" : "Conta Normal"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setModal(acc)}
                  className="p-2 rounded-md hover:bg-accent transition-colors"
                  title="Editar"
                >
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Remover "${acc.label}"?`)) remove.mutate(acc.id);
                  }}
                  className="p-2 rounded-md hover:bg-accent transition-colors"
                  title="Remover"
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground text-center">
        Máx 20 contas · Senhas criptografadas com AES-256 · Arquivo: <code className="bg-accent px-1 rounded">local-data.json</code>
      </p>

      {modal === "new" && <AccountModal onClose={() => setModal(null)} />}
      {modal !== "new" && modal !== null && (
        <AccountModal account={modal} onClose={() => setModal(null)} />
      )}
      
      {showTestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl overflow-hidden flex flex-col" style={{ height: "600px" }}>
            <div className="flex items-center justify-between p-4 border-b border-border bg-muted/50">
              <h2 className="font-black text-lg">Teste de Logins</h2>
              <button onClick={() => setShowTestModal(false)} className="p-1 hover:bg-accent rounded">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 p-0 overflow-hidden bg-black">
              <LogTerminal eventId="test-all-logins" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
