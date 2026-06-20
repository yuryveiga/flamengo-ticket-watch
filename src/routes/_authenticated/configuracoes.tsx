import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getOrCreateBotToken, rotateBotToken } from "@/lib/token.functions";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/configuracoes")({
  head: () => ({ meta: [{ title: "Configurações — TicketBot" }] }),
  component: Page,
});

function Page() {
  const getTok = useServerFn(getOrCreateBotToken);
  const rotTok = useServerFn(rotateBotToken);
  const [token, setToken] = useState<string>("");
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    getTok().then((r) => setToken(r.token));
  }, [getTok]);

  const copy = (v: string) => {
    navigator.clipboard.writeText(v);
    toast.success("Copiado");
  };
  const rotate = async () => {
    if (!confirm("Gerar novo token? O anterior deixa de funcionar.")) return;
    const r = await rotTok();
    setToken(r.token);
    toast.success("Token rotacionado");
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
      <h1 className="text-2xl font-black">Configurações</h1>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="font-bold">Como rodar o bot localmente</h2>
        <p className="text-sm text-muted-foreground">
          O bot agora está integrado neste projeto e roda de forma nativa. Para funcionar, você
          precisa do <code>SUPABASE_SERVICE_ROLE_KEY</code> configurado no seu arquivo{" "}
          <code>.env</code>.
        </p>
        <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Acesse o painel do Supabase.</li>
          <li>Vá em Project Settings &gt; API.</li>
          <li>Copie a chave secreta "service_role".</li>
          <li>
            Cole no arquivo <code>.env</code> como <code>SUPABASE_SERVICE_ROLE_KEY=sua-chave</code>.
          </li>
        </ol>
        <div className="mt-4 p-3 bg-muted rounded-md border border-border">
          <p className="text-sm font-mono">Abra um novo terminal e rode:</p>
          <code className="text-sm font-bold text-primary">bun run bot</code>
        </div>
      </section>
    </div>
  );
}

function KV({ k, v, onCopy }: { k: string; v: string; onCopy: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 bg-background border border-border rounded p-2">
      <span className="text-muted-foreground">{k}=</span>
      <span className="flex-1 truncate">{v}</span>
      <button onClick={() => onCopy(`${k}=${v}`)}>
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}
