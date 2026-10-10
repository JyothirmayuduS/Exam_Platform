// Evidence stores the retention job sweeps: the R2 bucket and the Supabase
// Storage bucket, both laid out as "<exam folder>/<student folder>/…".
import { listQuery, parseListPage } from "../admin/r2List.ts";
import type { EvidenceStore, Page, StoredObject } from "./job.ts";

export type Signer = { sign(req: Request): Promise<Request> };
export type R2Config = { aws: Signer; endpoint: string; bucket: string };

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export function r2Store(r2: R2Config, fetcher: typeof fetch = fetch): EvidenceStore {
  const base = `${r2.endpoint}/${r2.bucket}`;
  const list = async (opts: { prefix: string; delimiter?: string; token: string | null }) => {
    const res = await fetcher(await r2.aws.sign(new Request(`${base}?${listQuery(opts)}`, { method: "GET" })));
    if (!res.ok) { await res.body?.cancel(); throw new Error(`R2 list failed: HTTP ${res.status}`); }
    return parseListPage(await res.text());
  };
  return {
    name: "r2",
    async folders(prefix, token): Promise<Page<string>> {
      const page = await list({ prefix, delimiter: "/", token });
      return { items: page.prefixes.map((p) => p.slice(prefix.length).replace(/\/$/, "")).filter(Boolean), next: page.next };
    },
    async objects(prefix, token): Promise<Page<StoredObject>> {
      const page = await list({ prefix, token });
      return { items: page.objects.map((o) => ({ key: o.key, uploadedAt: o.lastModified })), next: page.next };
    },
    async remove(keys) {
      const failed: string[] = [];
      for (let i = 0; i < keys.length; i += 10) {
        const group = keys.slice(i, i + 10);
        await Promise.all(group.map(async (key) => {
          try {
            const res = await fetcher(await r2.aws.sign(new Request(`${base}/${encodeKey(key)}`, { method: "DELETE" })));
            await res.body?.cancel();
            if (!res.ok && res.status !== 404) failed.push(key);
          } catch {
            failed.push(key);
          }
        }));
      }
      return { failed };
    },
  };
}

export type LifecycleRule = { id: string; enabled: boolean; prefix: string; days: number | null };
export type Lifecycle = { configured: boolean; rules: LifecycleRule[]; error: string | null };

export function parseLifecycle(xml: string): LifecycleRule[] {
  return [...xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)].map((m) => {
    const rule = m[1];
    const expiration = tag(rule, "Expiration") ?? "";
    const days = tag(expiration, "Days");
    return {
      id: unescapeXml(tag(rule, "ID") ?? ""),
      enabled: (tag(rule, "Status") ?? "") === "Enabled",
      prefix: unescapeXml(tag(rule, "Prefix") ?? ""),
      days: days ? Number(days) : null,
    };
  });
}

/** The bucket's lifecycle rules, read so the console can warn when one deletes before the app would. */
export async function r2Lifecycle(r2: R2Config | null, fetcher: typeof fetch = fetch): Promise<Lifecycle> {
  if (!r2) return { configured: false, rules: [], error: "R2 secrets are not set" };
  try {
    const res = await fetcher(await r2.aws.sign(new Request(`${r2.endpoint}/${r2.bucket}?lifecycle`, { method: "GET" })));
    const body = await res.text();
    if (res.status === 404 || body.includes("NoSuchLifecycleConfiguration")) return { configured: true, rules: [], error: null };
    if (!res.ok) return { configured: true, rules: [], error: `HTTP ${res.status}` };
    return { configured: true, rules: parseLifecycle(body), error: null };
  } catch (e) {
    return { configured: true, rules: [], error: e instanceof Error ? e.message.slice(0, 200) : "Failed" };
  }
}

/** Enabled expiration rules that would delete evidence before the app's retention period. */
export const conflictingRules = (rules: LifecycleRule[], days: number) =>
  rules.filter((r) => r.enabled && r.days !== null && r.days <= days);

type StorageEntry = { name: string; id: string | null; created_at?: string | null; updated_at?: string | null };
type StorageBucketApi = {
  list(path: string, opts: { limit: number; offset: number; sortBy: { column: string; order: string } }): Promise<{ data: StorageEntry[] | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
};

const PAGE = 1000;

/** A Supabase Storage bucket. Its list API is one level at a time, so `objects` walks sub-folders. */
export function supabaseStore(bucket: string, api: StorageBucketApi): EvidenceStore {
  const entries = async (path: string, offset: number) => {
    const { data, error } = await api.list(path, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Storage list failed: ${error.message}`);
    return data ?? [];
  };
  const trim = (prefix: string) => prefix.replace(/\/+$/, "");
  return {
    name: `storage:${bucket}`,
    async folders(prefix, token) {
      const offset = Number(token ?? 0);
      const rows = await entries(trim(prefix), offset);
      return {
        items: rows.filter((r) => r.id === null && r.name !== ".emptyFolderPlaceholder").map((r) => r.name),
        next: rows.length === PAGE ? String(offset + PAGE) : null,
      };
    },
    async objects(prefix) {
      const items: StoredObject[] = [];
      const queue = [trim(prefix)];
      while (queue.length) {
        const dir = queue.shift()!;
        for (let offset = 0; ; offset += PAGE) {
          const rows = await entries(dir, offset);
          for (const r of rows) {
            if (r.id === null) queue.push(`${dir}/${r.name}`);
            else if (r.name !== ".emptyFolderPlaceholder") items.push({ key: `${dir}/${r.name}`, uploadedAt: r.created_at ?? r.updated_at ?? null });
          }
          if (rows.length < PAGE) break;
        }
      }
      return { items, next: null };
    },
    async remove(keys) {
      const { error } = await api.remove(keys);
      if (error) throw new Error(`Storage delete failed: ${error.message}`);
      return { failed: [] };
    },
  };
}
