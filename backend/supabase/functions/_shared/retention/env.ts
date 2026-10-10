// The evidence stores and R2 settings shared by evidence-retention and admin-dashboard.
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { r2Store, supabaseStore, type R2Config } from "./stores.ts";
import type { EvidenceStore } from "./job.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

export function r2Config(): R2Config | null {
  const accessKeyId = env("R2_ACCESS_KEY_ID"), secretAccessKey = env("R2_SECRET_ACCESS_KEY");
  const endpoint = env("R2_S3_ENDPOINT").replace(/\/+$/, ""), bucket = env("R2_BUCKET");
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;
  return { aws: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" }), endpoint, bucket };
}

/** R2 when configured, and the Supabase Storage evidence bucket (EVIDENCE_STORAGE_BUCKET, default exam-records). */
// deno-lint-ignore no-explicit-any
export function evidenceStores(db: any, r2: R2Config | null): EvidenceStore[] {
  const bucket = env("EVIDENCE_STORAGE_BUCKET") || "exam-records";
  return [...(r2 ? [r2Store(r2)] : []), supabaseStore(bucket, db.storage.from(bucket))];
}
