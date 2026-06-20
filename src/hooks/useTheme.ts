import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const KEY = "ticketbot.theme";

function getSystem(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return null;
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => getStored() ?? getSystem());

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Escuta mudanças do sistema quando não há preferência salva
  useEffect(() => {
    if (getStored()) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return { theme, toggle };
}
