// Admin console data and actions. Request and rules: _shared/admin/handler.ts.
// Deploy WITH JWT verification. Optional secrets:
//   SITE_URL                    public site checked by the health panel
//   LOCKDOWN_RELEASE_REPO       GitHub repo whose lockdown-v* releases are the exam browser
//   R2_*                        evidence bucket, counted one exam folder at a time
//   EVIDENCE_STORAGE_BUCKET     Supabase Storage evidence bucket swept by retention (default exam-records)
// The retention period lives in retention_settings (docs/retention.md).
// Backup status comes from public.backup_runs, written by the backup job (README, "Backups").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createAdminHandler, type AdminProbes, type HealthCheck, type Release } from "../_shared/admin/handler.ts";
import { supabaseAdminStore } from "../_shared/admin/supabaseStore.ts";
import { releaseVersion, type StorageObject } from "../_shared/admin/model.ts";
import { listQuery, parseListPage, type ListPage } from "../_shared/admin/r2List.ts";
import { evidenceStores, r2Config } from "../_shared/retention/env.ts";
import { r2Lifecycle } from "../_shared/retention/stores.ts";
import { supabaseRetentionDb } from "../_shared/retention/supabaseDb.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/+$/, "");
const db = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });

const r2 = r2Config();

async function timed(key: string, label: string, run: () => Promise<{ ok: boolean; detail: string }>): Promise<HealthCheck> {
  const t0 = performance.now();
  try {
    const r = await Promise.race([
      run(),
      new Promise<{ ok: boolean; detail: string }>((resolve) => setTimeout(() => resolve({ ok: false, detail: "No answer within 6 s" }), 6000)),
    ]);
    return { key, label, ...r, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { key, label, ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : "Failed", ms: null };
  }
}

const FUNCTIONS = ["submit-attempt", "store-artifact", "livekit-token", "lti", "results-export"];

let releaseCache: { at: number; value: Release | null } | null = null;

const probes: AdminProbes = {
  async health() {
    const site = env("SITE_URL");
    const livekit = env("LIVEKIT_URL").trim().replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
    return Promise.all([
      timed("site", "Website", async () => {
        if (!site) return { ok: false, detail: "SITE_URL is not set" };
        const r = await fetch(site, { redirect: "follow" });
        await r.body?.cancel();
        return { ok: r.ok, detail: `HTTP ${r.status}` };
      }),
      timed("database", "Database", async () => {
        const { error } = await db.from("exams").select("id").limit(1);
        return { ok: !error, detail: error ? error.message : "Answering queries" };
      }),
      timed("auth", "Sign-in service", async () => {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: env("SUPABASE_ANON_KEY") } });
        await r.body?.cancel();
        return { ok: r.ok, detail: `HTTP ${r.status}` };
      }),
      timed("functions", "Server functions", async () => {
        const codes = await Promise.all(FUNCTIONS.map(async (f) => {
          try {
            const r = await fetch(`${SUPABASE_URL}/functions/v1/${f}`, { method: "OPTIONS" });
            await r.body?.cancel();
            return r.status;
          } catch { return 0; }
        }));
        const down = FUNCTIONS.filter((_, i) => !codes[i] || codes[i] >= 500);
        return { ok: down.length === 0, detail: down.length ? `Not responding: ${down.join(", ")}` : `${FUNCTIONS.length} of ${FUNCTIONS.length} responding` };
      }),
      timed("video", "Live video (LiveKit)", async () => {
        if (!livekit) return { ok: false, detail: "LIVEKIT_URL is not set" };
        const r = await fetch(livekit);
        await r.body?.cancel();
        return { ok: r.status < 500, detail: `HTTP ${r.status}` };
      }),
      timed("r2", "Evidence storage (R2)", async () => {
        if (!r2) return { ok: false, detail: "R2 secrets are not set" };
        const r = await fetch(await r2.aws.sign(new Request(`${r2.endpoint}/${r2.bucket}?list-type=2&max-keys=1`, { method: "GET" })));
        await r.body?.cancel();
        return { ok: r.ok, detail: r.ok ? "Bucket reachable" : `HTTP ${r.status}` };
      }),
      timed("storage", "File storage (Supabase)", async () => {
        const { error } = await db.storage.listBuckets();
        return { ok: !error, detail: error ? error.message : "Reachable" };
      }),
    ]);
  },

  async latestRelease() {
    if (releaseCache && Date.now() - releaseCache.at < 10 * 60_000) return releaseCache.value;
    const repo = env("LOCKDOWN_RELEASE_REPO") || "JyothirmayuduS/Exam_Platform";
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers: { accept: "application/vnd.github+json", "user-agent": "vignan-admin-console" } });
    if (!r.ok) { await r.body?.cancel(); return releaseCache?.value ?? null; }
    const list = (await r.json()) as { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; html_url: string }[];
    const hit = list.find((x) => !x.draft && !x.prerelease && x.tag_name.startsWith("lockdown-v"));
    const value = hit ? { tag: hit.tag_name, version: releaseVersion(hit.tag_name), publishedAt: hit.published_at, url: hit.html_url } : null;
    releaseCache = { at: Date.now(), value };
    return value;
  },

  storageConfigured() {
    return !!r2;
  },

  async storageFolders() {
    if (!r2) return { configured: false, folders: [] };
    const folders: string[] = [];
    let token: string | null = null;
    do {
      const page = await listPage({ delimiter: "/", token });
      if ("error" in page) return { configured: true, folders, error: page.error };
      folders.push(...page.prefixes.map((p) => p.replace(/\/$/, "")).filter(Boolean));
      token = page.next;
    } while (token);
    return { configured: true, folders };
  },

  async listFolder(folder, token, maxPages) {
    const objects: StorageObject[] = [];
    let next: string | null = token;
    for (let i = 0; i < maxPages; i++) {
      const page = await listPage({ prefix: `${folder}/`, token: next });
      if ("error" in page) return { objects, next, error: page.error };
      objects.push(...page.objects);
      next = page.next;
      if (!next) break;
    }
    return { objects, next };
  },
};

async function listPage(opts: { prefix?: string; delimiter?: string; token: string | null }): Promise<ListPage | { error: string }> {
  if (!r2) return { error: "R2 secrets are not set" };
  const res = await fetch(await r2.aws.sign(new Request(`${r2.endpoint}/${r2.bucket}?${listQuery(opts)}`, { method: "GET" })));
  if (!res.ok) { await res.body?.cancel(); return { error: `R2 list failed: HTTP ${res.status}` }; }
  return parseListPage(await res.text());
}

async function actor(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user?.id ? { authId: String(data.user.id) } : null;
}

Deno.serve(createAdminHandler({
  store: supabaseAdminStore(db), probes, actor, now: Date.now,
  retention: { db: supabaseRetentionDb(db), stores: () => evidenceStores(db, r2), lifecycle: () => r2Lifecycle(r2) },
}));
