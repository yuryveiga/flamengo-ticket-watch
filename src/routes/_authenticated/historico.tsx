import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/historico")({
  head: () => ({ meta: [{ title: "Histórico — TicketBot" }] }),
  component: HistoricoPage,
});

type Row = {
  id: string;
  executed_at: string;
  setor: string | null;
  quantidade: number | null;
  status: string;
  event_id: string;
};

function HistoricoPage() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    supabase
      .from("results")
      .select("*")
      .order("executed_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (data) setRows(data as Row[]);
      });
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-2xl font-black">Histórico</h1>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-accent">
            <tr>
              <th className="text-left p-2">Data</th>
              <th className="text-left p-2">Setor</th>
              <th className="text-left p-2">Qtd</th>
              <th className="text-left p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center p-6 text-muted-foreground">
                  Nenhum registro.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-2">{new Date(r.executed_at).toLocaleString()}</td>
                <td className="p-2">{r.setor ?? "—"}</td>
                <td className="p-2">{r.quantidade ?? "—"}</td>
                <td
                  className={`p-2 font-semibold ${r.status === "Sucesso" ? "text-green-500" : r.status === "Cancelado" ? "text-muted-foreground" : "text-red-500"}`}
                >
                  {r.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
