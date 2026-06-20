import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Página não encontrada</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A página que você procura não existe ou foi movida.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Algo deu errado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ocorreu um erro ao carregar esta página. Você pode tentar recarregar ou voltar ao início.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Tentar novamente
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Voltar ao início
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Monitor de Fila — Ingressos" },
      {
        name: "description",
        content:
          "Monitor em tempo real da fila do Queue-it para ingressos. Avisa quando a fila libera.",
      },
      { name: "author", content: "Ticket Watch" },
      { property: "og:title", content: "Monitor de Fila — Ingressos" },
      {
        property: "og:description",
        content:
          "Monitor em tempo real da fila do Queue-it para ingressos. Avisa quando a fila libera.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Monitor de Fila — Ingressos" },
      {
        name: "twitter:description",
        content:
          "Monitor em tempo real da fila do Queue-it para ingressos. Avisa quando a fila libera.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

const isDev = import.meta.env.DEV;

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {isDev && (
          <script
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: `window.$RefreshReg$=function(){};window.$RefreshSig$=function(){return function(t){return t}};`,
            }}
          />
        )}
        {isDev && (
          <script
            type="module"
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: `
                import RefreshRuntime from "/@react-refresh"
                RefreshRuntime.injectIntoGlobalHook(window)
                window.$RefreshReg$ = () => {}
                window.$RefreshSig$ = () => (type) => type
                window.__vite_plugin_react_preamble_installed__ = true
              `,
            }}
          />
        )}
        {/* Injeta tema antes da hidratação React para evitar flash */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('ticketbot.theme');var s=t||(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(s==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

import { Toaster } from "@/components/ui/sonner";

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster />
    </QueryClientProvider>
  );
}
