// Daily evidence and results retention run (pg_cron, migrations/20261011000100).
// Deploy WITHOUT JWT verification; the caller must send x-retention-cron-secret.
// Secrets: RETENTION_CRON_SECRET, R2_* (evidence bucket), EVIDENCE_STORAGE_BUCKET (optional).
// What is deleted and what is kept: _shared/retention/job.ts and docs/retention.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRetentionCronHandler } from "../_shared/retention/cronHandler.ts";
import { evidenceStores, r2Config } from "../_shared/retention/env.ts";
import { runRetention } from "../_shared/retention/job.ts";
import { supabaseRetentionDb } from "../_shared/retention/supabaseDb.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(createRetentionCronHandler({
  secret: env("RETENTION_CRON_SECRET"),
  run: () => runRetention(
    { stores: evidenceStores(db, r2Config()), db: supabaseRetentionDb(db), now: Date.now },
    { dryRun: false, trigger: "schedule", requestedBy: null, budgetMs: 110_000 },
  ),
}));
