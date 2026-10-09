// RS256 JSON Web Tokens with Web Crypto only, so the same code runs in the
// Deno edge runtime and in the Node test runner.

export type Jwk = { kty: string; n?: string; e?: string; kid?: string; alg?: string; use?: string; [k: string]: unknown };
export type JwtClaims = Record<string, unknown>;
export type ToolKey = { privateKey: CryptoKey; publicJwk: Jwk; kid: string };

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeJwt(token: string): { header: JwtClaims; claims: JwtClaims; signed: string; signature: Uint8Array } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(dec.decode(base64UrlDecode(parts[0]))),
      claims: JSON.parse(dec.decode(base64UrlDecode(parts[1]))),
      signed: `${parts[0]}.${parts[1]}`,
      signature: base64UrlDecode(parts[2]),
    };
  } catch {
    return null;
  }
}

/** Verify an RS256 token against a JWK set. Returns the claims, or null when
 *  the signature, algorithm or key id does not check out. */
export async function verifyJwt(token: string, keys: Jwk[]): Promise<JwtClaims | null> {
  const parsed = decodeJwt(token);
  if (!parsed || parsed.header.alg !== "RS256") return null;
  const kid = parsed.header.kid;
  const candidates = keys.filter((k) => k.kty === "RSA" && (kid === undefined || k.kid === kid));
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, RS256, false, ["verify"]);
      if (await crypto.subtle.verify(RS256, key, parsed.signature as BufferSource, enc.encode(parsed.signed))) return parsed.claims;
    } catch {
      // Malformed key in the set: try the next one.
    }
  }
  return null;
}

export async function signJwt(claims: JwtClaims, key: CryptoKey, kid: string): Promise<string> {
  const head = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64UrlEncode(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign(RS256, key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64UrlEncode(sig)}`;
}

/** Load the tool's signing key from a PKCS#8 PEM or a private JWK (JSON). */
export async function loadToolKey(secret: string, kid: string): Promise<ToolKey> {
  const text = secret.trim();
  let privateKey: CryptoKey;
  if (text.startsWith("{")) {
    const jwk = JSON.parse(text);
    privateKey = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", key_ops: ["sign"] }, RS256, true, ["sign"]);
  } else {
    const b64 = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    privateKey = await crypto.subtle.importKey("pkcs8", der, RS256, true, ["sign"]);
  }
  const full = (await crypto.subtle.exportKey("jwk", privateKey)) as Jwk;
  return { privateKey, kid, publicJwk: { kty: "RSA", n: full.n, e: full.e, kid, alg: "RS256", use: "sig" } };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
