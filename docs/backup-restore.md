# Backup and restore

The platform has two kinds of data to protect: the **database** (exams,
questions, attempts, answers, marks, violations, users, audit logs) and the
**stored evidence** (recordings, screenshots, snapshots, reports and photos in
the R2 bucket and the Supabase Storage buckets). One script backs up both; a
second rebuilds a fresh Supabase project from a backup and checks the result.

| | |
|---|---|
| Back up | `backend/backup/backup.sh` |
| Restore and check | `backend/backup/restore.sh` |
| Tests | `backend/supabase/tests/backup-restore.test.ts` (runs with `npx vitest run` in `frontend/`) |
| Status in the app | Admin console → System → Backups (from `public.backup_runs`) |

The Supabase project is on the free plan, which keeps **no** backups of its
own. These scripts are the only backup.

## What a backup contains

Each run writes one database set and adds new evidence to one shared mirror:

```
<backup bucket>/
  db/<YYYY-MM-DDTHHMMSSZ>/      one folder per run, never changed afterwards
    roles.sql.gz                custom roles and role settings
    schema.sql.gz               our schemas (public …): tables, functions, policies, triggers
    migrations.sql.gz           supabase_migrations history, so `supabase db push` stays correct
    data.sql.gz                 all rows, including auth users and Storage object metadata
    platform.sql.gz             Storage RLS policies, realtime tables, cron jobs (restored switched off)
    listings/<store>.tsv        every evidence file (size, path) at the time of the backup
    manifest.json               row count per table, evidence totals, checksums, sample attempt and recording
    SHA256SUMS
  evidence/storage/<bucket>/…   copy of every Supabase Storage bucket (exam-records, question-media, student-photos)
  evidence/r2/…                 copy of the R2 evidence bucket
```

The database dump is the same split the Supabase CLI uses (`supabase db dump`),
plus what that leaves out: Storage policies, realtime publication tables,
pg_cron jobs and the `supabase_migrations` history. Evidence is copied with
rclone, file by file; a file already in the mirror is not copied again, and a
file deleted from the live bucket stays in the mirror until the backup bucket's
lifecycle rule removes it. The listing in each database set says exactly which
files belonged to that backup, so a restore brings back that point in time.

**Not in the backup** (keep these in the password manager or in git):

- edge function code (in git; the manifest records the commit) and edge function secrets (`supabase secrets list` shows the names);
- vault secret values (encrypted with a key that belongs to the project; the manifest lists their names);
- project settings: Auth providers, site and redirect URLs, SMTP, API keys;
- R2 and Storage bucket settings such as CORS and lifecycle rules;
- realtime messages, cron run history, logs, and the platform's own migration tables.

## How often

| What | When | Why |
|---|---|---|
| Full backup (database + evidence) | Daily at **18:30 UTC (00:00 IST)** | After the exam day, and before the evidence-retention job at 21:30 UTC, so nothing is deleted between the listing and the copy |
| Database only (`--skip-evidence`) | After each exam session on exam days | Answers and marks change fastest; the database backup takes about a minute and a half |
| Restore drill | Every 6 months, and after any change to these scripts or a major Supabase upgrade | A backup that has never been restored is not a backup |

Worst case without the extra exam-day runs, a disaster loses up to 24 hours of
data. Evidence is uploaded continuously during exams, so an exam-day database
backup also keeps the marks and the evidence they refer to close together.

Example crontab on the backup host (times in UTC):

```cron
30 18 * * *  cd /opt/exam-platform && set -a && . /etc/exam-backup.env && set +a && backend/backup/backup.sh >> /var/log/exam-backup.log 2>&1
```

## Where backups go

To a dedicated S3-compatible bucket, **`exam-platform-backups`**, kept apart
from the live data:

- use a separate Cloudflare account (or another provider such as Backblaze B2 or AWS S3), so one compromised or deleted account cannot take both copies;
- the backup job's API token can read and write that bucket only, and reads the live R2 bucket with a separate **read-only** token;
- no one else has write access to the backup bucket.

Never point a lifecycle rule at the live evidence bucket (the admin console
flags one as a conflict). Expiry belongs on the backup bucket only.

## How long backups are kept

The same as the site retention period: **5 years (1825 days)**. Set one
lifecycle rule on the backup bucket: delete objects 1825 days after they were
uploaded. That gives:

- each daily database set is kept for 5 years;
- each evidence file is kept for 5 years from when it was first copied. That is about as long as the app keeps it, because the app also counts 5 years from the exam. If a legal hold keeps a file live for longer, the mirror loses its copy when it expires, and the next backup copies it again.

If the retention period changes in the admin console (`retention_settings`),
change the lifecycle rule to match. Every manifest records the period that was
in force (`facts.retention_days`).

Data the app deletes at the end of its retention period can stay in older
backups for up to 5 more years. That is the price of being able to restore any
day from the last 5 years.

## Setting up the backup host

The scripts need `bash`, `node` 18 or later and `gzip`, plus either Docker, or
the Postgres 17 client tools and `rclone`. With Docker they use `postgres:17`
and `rclone/rclone` images; set `BACKUP_USE_DOCKER=1` to always use Docker.
A restore also needs `curl` and `ffmpeg` / `ffprobe`.

Secrets come from the environment only; nothing is read from or written to the
repository. Tool errors are passed through a filter that masks the value of
any `*KEY*`, `*SECRET*`, `*PASSWORD*`, `*TOKEN*` or `*_DB_URL` variable, so a
credential echoed back in an error message never reaches the log.

**Backup** (`backup.sh`):

| Variable | Value |
|---|---|
| `SOURCE_DB_URL` | Session pooler connection string with the database password (Dashboard → Connect → Session pooler; port 5432) |
| `SOURCE_DB_ROLE` | Optional. Role to `SET ROLE` to when the login user isn't `postgres` (for example a CLI login role). Don't schedule backups with a temporary CLI login: it expires partway through a long run, and the final report then fails (seen in the first drill) |
| `SOURCE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SOURCE_SERVICE_ROLE_KEY`, `SOURCE_ANON_KEY` | API keys; Storage is read over its S3 endpoint with these |
| `SOURCE_STORAGE_REGION` | Optional, default `ap-southeast-1` |
| `R2_S3_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The live evidence bucket, read-only token |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | The backup bucket |
| `BACKUP_S3_PROVIDER`, `BACKUP_S3_REGION`, `BACKUP_S3_PREFIX` | Optional; defaults `Cloudflare`, `auto`, none |
| `BACKUP_LOCAL_DIR` | Instead of the bucket, a local directory (tests and drills only) |

Each run is recorded with `public.record_backup_run`: a `running` row when it
starts, then `succeeded` with the location, total size and a summary (tables,
rows, evidence files, seconds), or `failed` with the step that failed. The
admin console shows the latest run, the last success and failures in the last
7 days. Alert when the last success is more than 26 hours old.

The script refuses to report success unless every evidence file it listed is in
the mirror with the same size, and every database file in the backup folder
matches the local copy.

## How to restore

Restore into a **new** Supabase project. The script refuses a project that
already has tables in `public`, and any project named in
`PROTECTED_PROJECT_REFS`. Set that to the live project ref on every machine
that has restore credentials.

1. **Decide and announce.** The exam cell head approves a production restore (see Who below), and staff are told the platform is down.
2. **Create the project**: same region (`ap-southeast-1`), Postgres 17, a new database password in the password manager.
3. **Create an empty R2 bucket** for the restored evidence (or skip this if the live R2 bucket is intact).
4. **Set the environment**, then run the restore:

   | Variable | Value |
   |---|---|
   | `TARGET_DB_URL` | New project's session pooler URL, user `postgres.<ref>` |
   | `TARGET_SUPABASE_URL`, `TARGET_SERVICE_ROLE_KEY`, `TARGET_ANON_KEY` | New project's URL and keys |
   | `TARGET_STORAGE_REGION` | Optional, default `ap-southeast-1` |
   | `BACKUP_S3_*` | The backup bucket, as for the backup |
   | `RESTORE_R2_BUCKET` | The empty bucket for restored R2 evidence |
   | `RESTORE_R2_ENDPOINT`, `RESTORE_R2_ACCESS_KEY_ID`, `RESTORE_R2_SECRET_ACCESS_KEY` | Optional; default to the `BACKUP_S3_*` values |
   | `PROTECTED_PROJECT_REFS` | The live project ref |

   ```bash
   backend/backup/restore.sh                    # newest backup
   backend/backup/restore.sh --stamp 2026-10-10T183000Z
   ```

   The script:
   - checks the backup files against `SHA256SUMS`;
   - loads roles, schema, migration history, data and platform objects in **one transaction**, so a failure leaves the project empty;
   - checks every cron job came back **switched off**;
   - compares every table's row count with the manifest;
   - checks the sample attempt shows the same score, answers and violations, by digest;
   - uploads every listed evidence file to the new project's buckets and the restored R2 bucket;
   - checks each listing is complete, then downloads a sample of 25 files per store and compares them byte for byte;
   - fetches the sample recording through a signed URL from the restored Storage, the way the app plays it, checks its checksum and decodes it with ffmpeg.

   It prints a JSON report. Keep it with the incident notes.

5. **After a restore**, before anyone uses it:
   - deploy the edge functions from the commit in `manifest.json` (`git_commit`), then `supabase db push` for any migrations newer than the backup;
   - set the edge function secrets on the new project; point `R2_BUCKET` at the restored bucket if the live one was lost;
   - re-create the vault secrets listed in `facts.vault_secret_names`, with values for the new project;
   - set the Auth settings (site URL, redirect URLs, SMTP) and the app's environment (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `APP_BASE_URL`) in Vercel, and redeploy;
   - **cron jobs are restored inactive.** Fix any URL in their commands that names the old project (`lti-grade-retry` does), then switch them on: `select cron.alter_job(jobid, active := true) from cron.job;`;
   - everyone signs in again: passwords carry over, sessions don't.

## How long a restore takes

Measured in the 11 October 2026 drill below. Data at the time: a 22 MB
database (95 tables, 5,264 rows), 969 Storage files (136 MiB) and 2,750 R2
files (695 MiB).

| Restore step | Time |
|---|---|
| Check the project is empty, download and verify the database set | 5 s |
| Load roles, schema, migration history, data and platform objects | 2 min 40 s |
| Check cron jobs, row counts and the sample attempt | 5 s |
| Upload Storage evidence (969 files, 136 MiB) and check it | 2 min 49 s |
| Upload R2 evidence (2,750 files, 695 MiB) and check it | 12 min 2 s |
| Fetch and decode the sample recording | 14 s |
| **Total** | **17 min 55 s** |

The backup took 16 min 36 s: 1 min 3 s for the database and 15 min 22 s for
the evidence. The first daily run copies everything; later runs copy only new
files.

The database load grows slowly with row count. Evidence dominates as data
grows: it moved at about 0.9 MB/s each way from the drill machine, so plan on
about 18 minutes per GB with the default 8 parallel transfers
(`BACKUP_TRANSFERS` raises it; a server in the same region is faster). Add about an hour for the steps after
the restore. **Target: platform back within 4 hours of the decision to restore,
with at most 24 hours of data lost** (less on exam days with the extra database
backups).

## Who does it

| Role | Responsibility |
|---|---|
| **Platform administrator** (IT) | Owns the backup host, the job and its alerts; checks the admin console's backup status every morning; runs restores and drills |
| **Exam cell head** | Approves a restore into production, decides which backup to use, and tells staff and students |
| **Second administrator** | Has access to the password manager entries and can run a restore if the first is unavailable |

Credentials needed for a restore live in the password manager: the backup
bucket token, the Supabase organisation owner login, the Cloudflare account,
and the edge function and vault secrets.

## Drill log

Each drill restores the latest backup into a throwaway Supabase project, never
the live one. The project is paused or deleted afterwards.

| Date | Backup | Duration | Result | Notes |
|---|---|---|---|---|
| 2026-10-11 (02:33–03:08 IST) | `2026-10-10T210343Z`, live project, 872 MB | Backup 16 min 36 s, restore 17 min 55 s; 34 min 32 s end to end | **Passed** | Restored into a fresh project in ap-southeast-1 (paused afterwards). All 95 tables' row counts matched (5,264 rows). The 3 cron jobs came back switched off. The sample attempt (score 2, 1 answer, 93 violations) matched by digest. All 969 Storage and 2,750 R2 files were present, with 25 per store downloaded and byte-identical. A 128.6 s VP8 recording played from restored Storage through a signed URL. One problem: the drill used a temporary CLI database login, which expired before the backup's final `record_backup_run`, so the run was recorded by hand afterwards. Scheduled runs must use the database password. |
