// Admin console data and actions. Request and rules: _shared/admin/handler.ts.
// Deploy WITH JWT verification. Optional secrets:
//   SITE_URL                    public site checked by the health panel
//   SUPABASE_MANAGEMENT_TOKEN   lets the console read the project's backup list
//   LOCKDOWN_RELEASE_REPO       GitHub repo whose lockdown-v* releases are the exam browser
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { createAdminHandler, type AdminProbes, type Backups, type HealthCheck, type Release } from "../_shared/admin/handler.ts";
import { supabaseAdminStore } from "../_shared/admin/supabaseStore.ts";
import { releaseVersion, type StorageObject } from "../_shared/admin/model.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/+$/, "");
const db = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });

const r2 = (() => {
  const accessKeyId = env("R2_ACCESS_KEY_ID"), secretAccessKey = env("R2_SECRET_ACCESS_KEY");
  const endpoint = env("R2_S3_ENDPOINT").replace(/\/+$/, ""), bucket = env("R2_BUCKET");
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;
  return { aws: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" }), endpoint, bucket };
})();

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

  async storageObjects() {
    if (!r2) return { configured: false, objects: [], truncated: false };
    const objects: StorageObject[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
      if (token) qs.set("continuation-token", token);
      const res = await fetch(await r2.aws.sign(new Request(`${r2.endpoint}/${r2.bucket}?${qs}`, { method: "GET" })));
      if (!res.ok) { await res.body?.cancel(); return { configured: true, objects, truncated: true, error: `R2 list failed: HTTP ${res.status}` }; }
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const part = m[1];
        objects.push({
          key: part.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "",
          size: Number(part.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
          lastModified: part.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? null,
        });
      }
      token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
      if (!token) return { configured: true, objects, truncated: false };
    }
    return { configured: true, objects, truncated: true };
  },

  retentionDays() {
    return Math.max(1, Math.min(3650, Number(env("RETENTION_DAYS") || 90)));
  },

  async backups(): Promise<Backups> {
    const token = env("SUPABASE_MANAGEMENT_TOKEN");
    if (!token) return { available: false, reason: "not_connected" };
    const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/backups`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) { await r.body?.cancel(); return { available: false, reason: `http_${r.status}` }; }
    const b = (await r.json()) as { pitr_enabled?: boolean; backups?: { inserted_at: string; status: string }[] };
    const list = (b.backups ?? []).slice().sort((x, y) => y.inserted_at.localeCompare(x.inserted_at));
    return { available: true, pitr: !!b.pitr_enabled, latest: list[0] ? { at: list[0].inserted_at, status: list[0].status } : null, count: list.length };
  },
};

async function actor(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user?.id ? { authId: String(data.user.id) } : null;
}

Deno.serve(createAdminHandler({ store: supabaseAdminStore(db), probes, actor, now: Date.now }));
