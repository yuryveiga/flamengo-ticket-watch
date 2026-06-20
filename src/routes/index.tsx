import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [{ title: "TicketBot — Monitor de Ingressos Flamengo" }],
  }),
  component: HomePage,
});

function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      {/* Glow de fundo */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: "20%",
            left: "50%",
            transform: "translateX(-50%)",
            width: "600px",
            height: "600px",
            borderRadius: "50%",
            background: "radial-gradient(circle, oklch(0.52 0.21 255 / 0.12) 0%, transparent 70%)",
            filter: "blur(60px)",
          }}
        />
      </div>

      <div className="flex flex-col items-center gap-6 text-center max-w-sm w-full">
        {/* Ícone */}
        <div
          style={{
            fontSize: "3.5rem",
            lineHeight: 1,
            filter: "drop-shadow(0 0 20px oklch(0.52 0.21 255 / 0.5))",
          }}
        >
          🎟️
        </div>

        {/* Título + subtítulo */}
        <div className="space-y-2">
          <h1
            className="text-foreground font-black"
            style={{ fontSize: "2rem", letterSpacing: "-0.03em" }}
          >
            TicketBot
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Monitor em tempo real da fila de ingressos do Flamengo.
            <br />
            Seja avisado quando a fila abrir.
          </p>
        </div>

        {/* CTA */}
        <Link
          to="/login"
          id="btn-entrar"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            padding: "0.75rem 1.5rem",
            borderRadius: "0.625rem",
            background: "var(--primary)",
            color: "var(--primary-foreground)",
            fontWeight: 700,
            fontSize: "0.9375rem",
            letterSpacing: "-0.01em",
            textDecoration: "none",
            transition: "opacity 0.15s, transform 0.15s",
            boxShadow: "0 4px 24px oklch(0.52 0.21 255 / 0.35)",
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLElement;
            el.style.opacity = "0.88";
            el.style.transform = "translateY(-2px)";
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLElement;
            el.style.opacity = "1";
            el.style.transform = "translateY(0)";
          }}
        >
          Entrar
        </Link>

        <p className="text-muted-foreground" style={{ fontSize: "0.72rem" }}>
          Acesso restrito a membros autorizados.
        </p>
      </div>
    </div>
  );
}
