// AES-GCM encryption for FutebolCard account passwords.
// Key is derived from LOCAL_CRYPTO_SECRET (or a hardcoded fallback) via SHA-256 — never leaves the server.

const SECRET_FALLBACK = "ticketbot-local-only-secret-2024";

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.LOCAL_CRYPTO_SECRET ?? SECRET_FALLBACK;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("ticketbot::" + secret),
  );
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptText(plain: string): Promise<string> {
  if (!plain) return "";
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptText(payload: string): Promise<string> {
  if (!payload) return "";
  const [v, ivB, ctB] = payload.split(":");
  if (v !== "v1") return "";
  const key = await getKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB) }, key, unb64(ctB));
  return new TextDecoder().decode(pt);
}
