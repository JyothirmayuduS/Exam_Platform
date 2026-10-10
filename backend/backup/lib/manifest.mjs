#!/usr/bin/env node
// Helpers for backup.sh and restore.sh: connection settings, the backup
// manifest, checksums and the row-count / file-listing comparisons.
// No dependencies beyond Node 18+. Never prints a secret except through
// `pg-env`, whose output is meant for `eval` and must not be logged.

import { createHash, randomInt } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

// --- connection ------------------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** libpq environment for a postgres:// URL. Password and user are percent-decoded. */
export function pgEnvFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("database URL is not a valid URL");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("database URL must start with postgres:// or postgresql://");
  if (!url.hostname) throw new Error("database URL has no host");
  if (!url.username) throw new Error("database URL has no user");
  const db = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  return {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: db,
    PGSSLMODE: url.searchParams.get("sslmode") || "require",
  };
}

export const shellExports = (env) =>
  Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n");

/** `https://<ref>.supabase.co` → `<ref>`. */
export function projectRef(supabaseUrl) {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)\/?$/.exec(String(supabaseUrl).trim());
  if (!m) throw new Error("Supabase URL must look like https://<project-ref>.supabase.co");
  return m[1];
}

const SECRET_NAME = /(KEY|SECRET|PASSWORD|TOKEN|_DB_URL)/i;

/** Values worth hiding: secret-looking env vars, and passwords inside DB URLs. */
export function secretValues(env) {
  const out = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue;
    if (value.length >= 8) out.add(value);
    if (/_DB_URL$/.test(name)) {
      try {
        const pw = new URL(value).password;
        if (pw.length >= 6) out.add(pw).add(decodeURIComponent(pw));
      } catch {
        // not a URL; the whole value is already covered
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactText(text, secrets) {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

// --- dumps -----------------------------------------------------------------

const COPY_RE = /^COPY ((?:"(?:[^"]|"")+"|[^\s.]+)\.(?:"(?:[^"]|"")+"|[^\s(]+)) (?:\(.*\) )?FROM stdin;$/;
const unquote = (q) => q.split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.replace(/^"|"$/g, "").replace(/""/g, '"')).join(".");

/** Rows per table in a pg_dump COPY data file. COPY escapes newlines, so one line is one row. */
export async function countCopyRows(lines) {
  const counts = {};
  let table = null;
  for await (const line of lines) {
    if (table === null) {
      const m = COPY_RE.exec(line);
      if (m) {
        table = unquote(m[1]);
        counts[table] = counts[table] ?? 0;
      }
    } else if (line === "\\.") {
      table = null;
    } else {
      counts[table] += 1;
    }
  }
  if (table !== null) throw new Error(`data dump ends inside the COPY block for ${table}`);
  return counts;
}

export function fileLines(path) {
  const input = createReadStream(path);
  return createInterface({ input: path.endsWith(".gz") ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

// --- listings --------------------------------------------------------------

/** `rclone lsf --format sp --separator "\t"` output → [{ path, size }]. */
export function parseListing(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    if (tab < 0) throw new Error(`bad listing line: ${line}`);
    return { size: Number(line.slice(0, tab)), path: line.slice(tab + 1) };
  });
}

export const summarize = (files) => ({ objects: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });

/** Every file in `expected` must be in `actual` with the same size. Extra files are allowed. */
export function compareListings(expected, actual) {
  const have = new Map(actual.map((f) => [f.path, f.size]));
  const missing = [];
  const wrongSize = [];
  for (const f of expected) {
    if (!have.has(f.path)) missing.push(f.path);
    else if (have.get(f.path) !== f.size) wrongSize.push(f.path);
  }
  return { ok: missing.length === 0 && wrongSize.length === 0, missing, wrongSize };
}

export function sampleFiles(files, n, always = []) {
  const pool = files.filter((f) => !always.includes(f.path));
  const picked = new Set(always.filter((p) => files.some((f) => f.path === p)));
  const target = Math.min(files.length, n + picked.size);
  while (picked.size < target && pool.length) {
    picked.add(pool.splice(randomInt(pool.length), 1)[0].path);
  }
  return [...picked];
}

/** Largest recording in a listing, for when the database has none to offer. */
export function pickRecording(files) {
  return files.filter((f) => /\.(webm|mp4|mkv|ogg)$/i.test(f.path)).sort((a, b) => b.size - a.size)[0] ?? null;
}

// --- row counts ------------------------------------------------------------

const qi = (name) => `"${name.replace(/"/g, '""')}"`;
const qt = (table) => table.split(/\.(.*)/s).slice(0, 2).map(qi).join(".");
const ql = (s) => `'${s.replace(/'/g, "''")}'`;

/** One `table<TAB>count` line per table. */
export function countSql(tables) {
  if (!tables.length) return "select null where false;\n";
  return tables.map((t) => `select ${ql(t)} || E'\\t' || count(*) from ${qt(t)}`).join("\nunion all\n") + ";\n";
}

export function parseCounts(text) {
  const out = {};
  for (const line of text.split("\n").filter(Boolean)) {
    const tab = line.lastIndexOf("\t");
    out[line.slice(0, tab)] = Number(line.slice(tab + 1));
  }
  return out;
}

export function compareCounts(expected, actual) {
  const diffs = [];
  for (const [table, n] of Object.entries(expected)) {
    if (!(table in actual)) diffs.push({ table, expected: n, actual: null });
    else if (actual[table] !== n) diffs.push({ table, expected: n, actual: actual[table] });
  }
  return { ok: diffs.length === 0, tables: Object.keys(expected).length, rows: Object.values(expected).reduce((a, b) => a + b, 0), diffs };
}

// --- manifest --------------------------------------------------------------

export const DB_FILES = ["roles.sql.gz", "schema.sql.gz", "migrations.sql.gz", "data.sql.gz", "platform.sql.gz"];

/** Reads <work>/db, <work>/listings and <work>/facts.json; writes manifest.json and SHA256SUMS into <work>/db. */
export async function buildManifest(work, meta) {
  const dbDir = join(work, "db");
  const files = {};
  for (const name of DB_FILES) {
    const p = join(dbDir, name);
    if (!existsSync(p)) throw new Error(`missing ${name}`);
    files[name] = { bytes: statSync(p).size, sha256: await sha256File(p) };
  }
  const listingsDir = join(work, "listings");
  const evidence = {};
  for (const f of existsSync(listingsDir) ? readdirSync(listingsDir).filter((n) => n.endsWith(".tsv")).sort() : []) {
    const store = basename(f, ".tsv");
    const listing = parseListing(readFileSync(join(listingsDir, f), "utf8"));
    evidence[store] = { ...summarize(listing), listing: `listings/${f}` };
    const gz = join(dbDir, "listings", f);
    if (existsSync(gz)) files[`listings/${f}`] = { bytes: statSync(gz).size, sha256: await sha256File(gz) };
  }
  const rows = await countCopyRows(fileLines(join(dbDir, "data.sql.gz")));
  const facts = JSON.parse(readFileSync(join(work, "facts.json"), "utf8"));
  const manifest = { format: 1, ...meta, files, rows, evidence, facts };
  writeFileSync(join(dbDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const sums = Object.entries(files).map(([n, f]) => `${f.sha256}  ${n}`).join("\n") + "\n";
  writeFileSync(join(dbDir, "SHA256SUMS"), sums);
  return manifest;
}

export async function verifySums(dir) {
  const bad = [];
  for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").split("\n").filter(Boolean)) {
    const [sum, name] = line.split(/ {2}(.*)/s);
    const p = join(dir, name);
    if (!existsSync(p)) bad.push(`${name}: missing`);
    else if ((await sha256File(p)) !== sum) bad.push(`${name}: checksum mismatch`);
  }
  return bad;
}

const at = (obj, path) => path.split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function setAt(obj, path, value) {
  const keys = path.split(".").filter(Boolean);
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k] ??= {};
  o[last] = value;
  return obj;
}

/** Same JSON value, ignoring key order. */
export function sameJson(a, b) {
  const norm = (v) =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// --- CLI -------------------------------------------------------------------

async function main([cmd, ...args]) {
  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
  switch (cmd) {
    case "pg-env": {
      const raw = process.env[args[0] ?? ""];
      if (!raw) throw new Error(`${args[0]} is not set`);
      process.stdout.write(shellExports(pgEnvFromUrl(raw)) + "\n");
      return;
    }
    case "ref":
      process.stdout.write(projectRef(process.env[args[0]] ?? "") + "\n");
      return;
    case "build": {
      const m = await buildManifest(args[0], JSON.parse(args[1] ?? "{}"));
      const rows = Object.values(m.rows).reduce((a, b) => a + b, 0);
      process.stdout.write(`${Object.keys(m.rows).length} tables, ${rows} rows\n`);
      return;
    }
    case "verify-sums": {
      const bad = await verifySums(args[0]);
      if (bad.length) throw new Error(`backup files failed verification:\n  ${bad.join("\n  ")}`);
      return;
    }
    case "count-sql":
      process.stdout.write(countSql(Object.keys(readJson(args[0]).rows)));
      return;
    case "compare-counts": {
      const r = compareCounts(readJson(args[0]).rows, parseCounts(readFileSync(args[1], "utf8")));
      process.stdout.write(JSON.stringify(r) + "\n");
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "compare-listing": {
      const r = compareListings(parseListing(readFileSync(args[0], "utf8")), parseListing(readFileSync(args[1], "utf8")));
      process.stdout.write(JSON.stringify({ ...r, missing: r.missing.slice(0, 20), wrongSize: r.wrongSize.slice(0, 20), missingTotal: r.missing.length, wrongSizeTotal: r.wrongSize.length }) + "\n");
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "summary":
      process.stdout.write(JSON.stringify(summarize(parseListing(readFileSync(args[0], "utf8")))) + "\n");
      return;
    case "sample": {
      const picked = sampleFiles(parseListing(readFileSync(args[0], "utf8")), Number(args[1] ?? 25), args.slice(2));
      process.stdout.write(picked.map((p) => `${p}\n`).join(""));
      return;
    }
    case "pick-recording": {
      const r = pickRecording(parseListing(readFileSync(args[0], "utf8")));
      process.stdout.write(r ? `${r.path}\n` : "");
      return;
    }
    case "get": {
      const v = at(readJson(args[0]), args[1] ?? "");
      if (v === undefined || v === null) return;
      process.stdout.write((typeof v === "object" ? JSON.stringify(v) : String(v)) + "\n");
      return;
    }
    case "set": {
      const obj = readJson(args[0]);
      writeFileSync(args[0], JSON.stringify(setAt(obj, args[1], JSON.parse(args[2])), null, 2) + "\n");
      return;
    }
    case "lines": {
      const v = at(readJson(args[0]), args[1] ?? "") ?? [];
      process.stdout.write(v.map((x) => (args[2] ? x[args[2]] : x)).join("\n") + (v.length ? "\n" : ""));
      return;
    }
    case "sha256":
      process.stdout.write((await sha256File(args[0])) + "\n");
      return;
    case "same-json": {
      const actual = readJson(args[0]);
      const expected = at(readJson(args[1]), args[2] ?? "");
      if (!sameJson(actual, expected)) {
        process.stdout.write(`expected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "redact": {
      const secrets = secretValues(process.env);
      for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        process.stdout.write(redactText(line, secrets) + "\n");
      }
      return;
    }
    case "encode-path":
      process.stdout.write(args[0].split("/").map(encodeURIComponent).join("/") + "\n");
      return;
    default:
      throw new Error(`unknown command: ${cmd ?? "(none)"}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`manifest: ${e.message}\n`);
    process.exit(1);
  });
}
