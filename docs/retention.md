# Evidence and results retention

The platform keeps exam evidence and results for one site-wide retention period,
**1825 days (5 years) by default**, and then deletes only what has expired. The
app is the only thing that deletes: nothing else (no bucket rule, no other cron
job) should remove evidence or results.

## What is kept, and for how long

| Kind | Where | Age counted from |
| --- | --- | --- |
| Recordings, snapshots, answer sheets, violation frames, reports | R2 bucket and the `exam-records` Supabase Storage bucket, under `<exam folder>/<student folder>/…` | the file's upload time |
| Results and marks (attempts with their answers, grading, comments, AI reports) | `attempts` and the tables that cascade from it | submission (else start) time |
| Violation records | `violation_events` | `created_at` |
| Audit log entries | `audit_logs` | `created_at` |

The period lives in `retention_settings` (30–3650 days). Only admins can change
it, from **Admin → Storage & data → Retention** or the `set_retention` admin op;
each change is written to the audit log as `admin.retention_changed` with the old
and new value.

## What is never deleted

The job skips, and counts as "kept (held)":

- an attempt on a **malpractice hold** (`result_holds`);
- anything for an **exam or student on a legal hold** (`legal_holds`);
- an attempt with an **open appeal** (`appeal_requests` or `student_appeals` not yet resolved);
- an attempt **under review**: a high or critical violation flag nobody has reviewed yet;
- evidence files whose holds could not be checked in that run, or with no upload date.

Admins place and lift legal holds on an exam or a student from the same page (a
reason is required to place one). Both actions are audited as
`admin.legal_hold_placed` / `admin.legal_hold_lifted`. Lifting a hold does not
restart the clock: retention still counts from the original upload or submission
date, so anything already past the period is deleted on the next run.

## The deletion job

- `evidence-retention` edge function, called daily at 03:00 IST by the
  `evidence-retention` pg_cron job (migration `20261011000100`). It runs without
  a user session and only accepts the `x-retention-cron-secret` header.
- It deletes database rows in batches (`retention_db_batch`), then pages through
  each evidence store exam folder by exam folder and student folder by student
  folder, checks holds per folder (`retention_folder_status`), and deletes
  expired files in batches of 100.
- Every run is logged in `retention_runs` with deleted, skipped and failed
  counts, per kind and per store, plus the first errors. A failed batch is
  logged and the job carries on. A run that reaches its time limit stops at an
  exam folder and the next run resumes from there.
- Admins can start a **dry run** (counts only, deletes nothing) and then confirm
  a real run within 30 minutes. Real runs started by an admin are audited as
  `admin.retention_run`.

## Setup

```bash
# 1. The shared secret for the cron call (generate it; never commit it).
S=$(openssl rand -hex 32)
supabase secrets set RETENTION_CRON_SECRET="$S"

# 2. The same secret and the function URL in Vault, read by the cron job.
#    (Run in the SQL editor, pasting the value instead of echoing it.)
select vault.create_secret('https://<ref>.supabase.co/functions/v1/evidence-retention', 'evidence_retention_url');
select vault.create_secret('<the secret>', 'evidence_retention_cron_secret');

# 3. Deploy without JWT verification (config.toml sets verify_jwt = false).
supabase functions deploy evidence-retention
```

The function also needs the R2 secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_S3_ENDPOINT`, `R2_BUCKET`), and optionally `EVIDENCE_STORAGE_BUCKET` (default
`exam-records`).

## R2 lifecycle rule: remove it

Because the app is the source of truth, **the R2 bucket must not have a lifecycle
rule that expires evidence**, or it must be set longer than the app's retention
period. A bucket rule deletes regardless of malpractice holds, legal holds,
appeals or reviews.

- Cloudflare dashboard → R2 → the evidence bucket → Settings → Object lifecycle
  rules → delete the expiration rule (or set it to more days than the app period).
- The admin console reads the bucket's lifecycle rules on every visit to
  **Storage & data** and shows a red warning when an enabled rule expires objects
  at or before the app's period.
- The old `r2-retention` function, which created a 90-day rule named
  `exam-artifacts-retention`, has been removed.

### Current rule

Checked on 2026-10-10 through the admin console's lifecycle read:

| Rule ID | Status | Prefix | Expires after |
| --- | --- | --- | --- |
| `exam-artifacts-retention` | Enabled | (whole bucket) | 90 days |

This rule was created by the removed `r2-retention` function. It is shorter than
the 1825-day app period and ignores holds, so **it must be deleted** (or set to
more than 1825 days). The oldest evidence in R2 was uploaded in early September
2026, so the rule starts deleting it around 2 December 2026 if left in place.
