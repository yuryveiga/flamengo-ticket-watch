import { useNavigate, Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Entrar — TicketBot" }] }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Mock login for local version
      setTimeout(() => {
        localStorage.setItem("local_auth", "true");
        toast.success("Login efetuado (Modo Local)");
        nav({ to: "/dashboard" });
      }, 500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-sm space-y-6 p-6 rounded-xl border border-border bg-card">
        <div className="text-center space-y-1">
          <div className="text-3xl">🎟</div>
          <h1 className="text-2xl font-black">TicketBot</h1>
          <p className="text-xs text-muted-foreground">Versão Local (Sem Nuvem)</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Qualquer email"
            className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Qualquer senha"
            className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
          />
          <button
            disabled={loading}
            type="submit"
            className="w-full py-2 rounded-md bg-primary text-primary-foreground font-semibold disabled:opacity-50"
          >
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>

      </div>
    </div>
  );
}
