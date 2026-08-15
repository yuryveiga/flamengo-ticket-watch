import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza qualquer URL do FutebolCard para o formato correto de compra.
 * Suporta /information, /buy/sector, /event, ou qualquer path com ?event=XXXXX.
 * Retorna a URL original se não conseguir extrair o event ID.
 *
 * @example
 * toSectorUrl("https://www.futebolcard.com/information?event=39297")
 * // → "https://www.futebolcard.com/buy/sector?event=39297"
 */
export function toSectorUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("futebolcard.com")) return url;
    const eventId = parsed.searchParams.get("event");
    if (!eventId) return url;
    return `https://www.futebolcard.com/buy/sector?event=${eventId}`;
  } catch {
    return url;
  }
}
