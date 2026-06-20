import {
  createFileRoute,
  redirect,
  Outlet,
  Link,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Calendar,
  History,
  Settings,
  LogOut,
  Menu,
  X,
  UserCircle2,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ location }) => {
    // Local mode: bypassed auth check.
    const loggedIn = localStorage.getItem("local_auth");
    if (!loggedIn) {
      throw redirect({
        to: "/login",
        search: {
          redirect: location.href,
        },
      });
    }
  },
  component: AuthLayout,
});

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/eventos", label: "Eventos", icon: Calendar },
  { to: "/contas", label: "Contas", icon: UserCircle2 },
  { to: "/historico", label: "Histórico", icon: History },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
] as const;

function AuthLayout() {
  const nav = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const email = "local-user@localhost";

  const logout = async () => {
    localStorage.removeItem("local_auth");
    nav({ to: "/login" });
  };

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      {/* Sidebar */}
      <aside
        className={`${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 fixed md:static z-40 top-0 left-0 h-full w-64 bg-card border-r border-border flex flex-col transition-transform`}
      >
        <div className="p-4 border-b border-border flex items-center gap-2">
          <div className="h-8 w-8 rounded bg-primary flex items-center justify-center">🎟</div>
          <div className="font-black">TicketBot</div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {NAV.map((n) => {
            const active = pathname.startsWith(n.to);
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${active ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                <Icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-border space-y-2">
          <div className="text-xs text-muted-foreground truncate">{email}</div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-accent"
          >
            <LogOut className="h-4 w-4" />
            Sair
          </button>
        </div>
      </aside>

      {/* Mobile topbar */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-12 bg-card border-b border-border flex items-center px-3 z-30">
        <button onClick={() => setOpen(!open)} className="p-1">
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <span className="ml-2 font-black">TicketBot</span>
      </div>

      <main className="flex-1 md:ml-0 mt-12 md:mt-0 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
