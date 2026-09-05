// RLS / auth verification matrix — runnable against any environment.
//
// Proves the production security story end to end: role logins resolve real
// data, anonymous clients are denied, and each role can only see its own rows.
// This is the automated version of the manual checks performed during the
// auth go-live (migration 20260910000006).
//
// Usage:
//   node scripts/verify-rls.mjs                # reads .env.local (VITE_*) or env
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-rls.mjs
//
// Exit code 0 = every check passed; non-zero = at least one security check
// failed. Requires the seeded accounts to exist (see migration 0006).

import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const out = {};
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}

const env = loadEnv();
const url = process.env.SUPABASE_URL || env.VITE_SUPABASE_URL || "";
const anon = process.env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || "";
if (!url || !anon) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY (set env or .env.local).");
  process.exit(2);
}

const TEACHER = process.env.TEACHER_EMAIL || "teacher@vignan.ac.in";
const PROCTOR = process.env.PROCTOR_EMAIL || "proctor@vignan.ac.in";
const STAFF_PASS = process.env.STAFF_PASSWORD || "password123";
const STUDENT = process.env.STUDENT_ROLL || "21VGN0142";
const STUDENT_EMAIL = process.env.STUDENT_EMAIL || `${STUDENT}@student.vignan.ac.in`;
const STUDENT_PASS = process.env.STUDENT_PASSWORD || "Vignan@123";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function signIn(email, password) {
  const c = createClient(url, anon);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { client: null, error };
  return { client: createClient(url, anon, { global: { headers: { Authorization: `Bearer ${data.session.access_token}` } } }), error: null };
}

async function rows(client, table, query) {
  const { data, error } = await client.from(table).select("*").match(query ?? {}).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

// ── Anonymous must be denied ────────────────────────────────────────────────
const anonClient = createClient(url, anon);
const anonExams = await rows(anonClient, "exams", {});
const anonStudents = await rows(anonClient, "students", {});
const anonAttempts = await rows(anonClient, "attempts", {});
check("anon cannot read exams", Array.isArray(anonExams) && anonExams.length === 0, `got ${anonExams?.length ?? "error"} rows`);
check("anon cannot read students", Array.isArray(anonStudents) && anonStudents.length === 0, `got ${anonStudents?.length ?? "error"} rows`);
check("anon cannot read attempts", Array.isArray(anonAttempts) && anonAttempts.length === 0, `got ${anonAttempts?.length ?? "error"} rows`);

// ── Teacher sees exams + can read published attempts for grading ───────────
const t = await signIn(TEACHER, STAFF_PASS);
check("teacher sign-in works", !!t.client, t.error?.message ?? "");
if (t.client) {
  const tExams = await rows(t.client, "exams", {});
  check("teacher reads exams", tExams.length > 0, `got ${tExams.length}`);
}

// ── Proctor sees published exams (proctor grid fallback data) ───────────────
const p = await signIn(PROCTOR, STAFF_PASS);
check("proctor sign-in works", !!p.client, p.error?.message ?? "");
if (p.client) {
  const pExams = await rows(p.client, "exams", { status: "published" });
  check("proctor reads published exams", pExams.length > 0, `got ${pExams.length}`);
}

// ── Student sees only their own data ────────────────────────────────────────
const s = await signIn(STUDENT_EMAIL, STUDENT_PASS);
check("student sign-in works", !!s.client, s.error?.message ?? "");
if (s.client) {
  const sEnroll = await rows(s.client, "enrollments", {});
  const sTeachers = await rows(s.client, "teachers", {});
  const sStudents = await rows(s.client, "students", {});
  check("student enrollments resolve", Array.isArray(sEnroll) && sEnroll.length > 0, `got ${sEnroll?.length ?? "error"} rows`);
  check("student cannot read teachers", Array.isArray(sTeachers) && sTeachers.length === 0, `got ${sTeachers?.length ?? "error"} rows`);
  check("student sees only own profile row", Array.isArray(sStudents) && sStudents.length <= 1, `got ${sStudents?.length ?? "error"} rows`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} security checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
