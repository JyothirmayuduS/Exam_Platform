// EvidenceBrowser.tsx — R2-first evidence archive.
//
// Every other review surface (proctor grid, submissions, reports) is driven by
// the attempts table in Postgres: if the DB has no attempts rows — or RLS hides
// them — nothing is reviewable even though Cloudflare R2 may hold recordings,
// per-second snapshots, violation frames, PDF reports and AI evidence for MANY
// exams and MANY students.
//
// This page inverts that: it browses the Cloudflare R2 bucket DIRECTLY,
// top-level folders = exams (slug of the exam name, so it reads like the
// console), second level = students (roll numbers), then drills into one
// candidate's full evidence: recording player, snapshot gallery, flagged
// frames, PDF report and the AI integrity report. Names are resolved from the
// DB as a best-effort overlay — the bucket is always the source of truth, so
// even an exam renamed since the session, or a DB that's unreachable, still
// shows what was stored.

import { useEffect, useMemo, useState } from "react";
import { FiDownload, FiArrowLeft, FiFolder, FiUser, FiVideo, FiImage, FiAlertTriangle, FiFileText } from "react-icons/fi";
import { supabaseConfigured } from "../lib/env";
import { getSupabase } from "../lib/supabase";
import {
  listR2ExamFolders,
  listR2StudentFolders,
  listArtifactsByPrefix,
  getArtifactObjectUrl,
  storageFolderSegment,
  type R2Artifact,
} from "../lib/examStorage";
import { listExams, listAttemptViolations, type ViolationEvent } from "../lib/examApi";
import RecordingReviewer from "../components/RecordingReview";
import AIIntegrityCard from "../components/AIIntegrityCard";
import { downloadExamEvidenceZip } from "../lib/zipExport";

type ExamFolder = {
  /** Stored folder segment, e.g. "Test-3" (no trailing slash). */
  folder: string;
  /** DB overlay when the folder matches a live exam. */
  examId?: string;
  name?: string;
  batch?: string;
};

type StudentRow = {
  roll: string;
  name?: string;
  studentId?: string;
  attemptId?: string;
  state?: string;
  counts?: { recordings: number; screenshots: number; violations: number; report: number };
};

function stripSlash(folder: string): string {
  return folder.replace(/\/+$/, "");
}

function kindCounts(arts: R2Artifact[] | null): { recordings: number; screenshots: number; violations: number; report: number } {
  const c = { recordings: 0, screenshots: 0, violations: 0, report: 0 };
  for (const a of arts ?? []) {
    if (a.kind === "recordings") c.recordings += 1;
    else if (a.kind === "screenshots") c.screenshots += 1;
    else if (a.kind === "violations") c.violations += 1;
    else if (a.kind === "report") c.report += 1;
  }
  return c;
}

export default function EvidenceBrowser() {
  const [exams, setExams] = useState<ExamFolder[] | null>(null);
  const [examError, setExamError] = useState<string | null>(null);
  const [selectedExam, setSelectedExam] = useState<ExamFolder | null>(null);
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(null);
  const [search, setSearch] = useState("");

  // Level 1: top-level R2 folders (one per exam) + DB name overlay.
  useEffect(() => {
    if (!supabaseConfigured) {
      setExamError("Supabase is not configured — R2 storage is unavailable.");
      setExams([]);
      return;
    }
    let alive = true;
    void (async () => {
      const folders = await listR2ExamFolders();
      if (!alive) return;
      if (!folders) {
        setExamError("Could not reach Cloudflare R2 — check the store-artifact edge function deployment and secrets (see SETUP.md §4a).");
        setExams([]);
        return;
      }
      // Best-effort name overlay from the exams table.
      const bySegment = new Map<string, { id: string; name: string; batch?: string | null }>();
      try {
        const all = await listExams();
        for (const e of all ?? []) {
          const seg = storageFolderSegment(e.id, e.name);
          bySegment.set(seg, { id: e.id, name: e.name, batch: e.batch });
          bySegment.set(e.id, { id: e.id, name: e.name, batch: e.batch }); // legacy id folders
        }
      } catch { /* offline — folders still render with their stored names */ }
      if (!alive) return;
      const rows: ExamFolder[] = folders.map((f) => {
        const seg = stripSlash(f);
        const meta = bySegment.get(seg);
        return { folder: seg, examId: meta?.id, name: meta?.name ?? seg, batch: meta?.batch ?? undefined };
      });
      setExams(rows);
    })();
    return () => { alive = false; };
  }, []);

  // Level 2: student folders under the selected exam + per-student summaries.
  useEffect(() => {
    if (!selectedExam) {
      setStudents(null);
      return;
    }
    let alive = true;
    setStudents(null);
    void (async () => {
      const raw = await listR2StudentFolders(selectedExam.folder);
      if (!alive) return;
      if (!raw) {
        setStudents([]);
        return;
      }
      const rolls = raw.map((f) => stripSlash(f));
      const rows: StudentRow[] = rolls.map((roll) => ({ roll }));

      // DB overlay: names by roll, attempt state by student.
      try {
        const db = getSupabase();
        if (db) {
          const { data: stData } = await db.from("students").select("id, roll, full_name").in("roll", rolls);
          const byRoll = new Map<string, { id: string; full_name: string | null }>();
          for (const s of (stData as { id?: string; roll?: string; full_name?: string | null }[] | null) ?? []) {
            if (s.roll) byRoll.set(s.roll, { id: String(s.id ?? ""), full_name: s.full_name ?? null });
          }
          if (selectedExam.examId) {
            const { data: attData } = await db
              .from("attempts")
              .select("id, student_id, state")
              .eq("exam_id", selectedExam.examId);
            const byStudent = new Map<string, { id: string; state?: string }>();
            for (const a of (attData as { id?: string; student_id?: string; state?: string }[] | null) ?? []) {
              if (a.student_id) byStudent.set(String(a.student_id), { id: String(a.id ?? ""), state: a.state });
            }
            for (const r of rows) {
              const st = byRoll.get(r.roll);
              if (st) {
                r.name = st.full_name ?? undefined;
                r.studentId = st.id;
              }
              const att = st ? byStudent.get(st.id) : undefined;
              if (att) {
                r.attemptId = att.id;
                r.state = att.state;
              }
            }
          } else {
            for (const r of rows) {
              const st = byRoll.get(r.roll);
              if (st) r.name = st.full_name ?? undefined;
            }
          }
        }
      } catch { /* names/attempts are an overlay — rolls alone are enough */ }

      // Artifact counts per student (bounded concurrency so a big class never
      // floods the edge function at once).
      const CONCURRENCY = 8;
      let cursor = 0;
      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(CONCURRENCY, rows.length); w++) {
        workers.push((async () => {
          while (cursor < rows.length) {
            const i = cursor;
            cursor += 1;
            const arts = await listArtifactsByPrefix(`${selectedExam.folder}/${rows[i].roll}/`);
            if (alive) rows[i].counts = kindCounts(arts);
          }
        })());
      }
      await Promise.all(workers);
      if (!alive) return;
      setStudents(rows);
    })();
    return () => { alive = false; };
  }, [selectedExam]);

  const visibleExams = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = exams ?? [];
    if (!q) return list;
    return list.filter((e) => (e.name ?? e.folder).toLowerCase().includes(q) || e.folder.toLowerCase().includes(q));
  }, [exams, search]);

  const backToExams = () => { setSelectedExam(null); setSelectedStudent(null); };
  const backToStudents = () => setSelectedStudent(null);

  return (
    <div className="mt-8 space-y-8">
      <div className="flex flex-col justify-between gap-4 border-b border-line pb-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Evidence archive / Cloudflare R2</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold">
            {selectedStudent ? `Evidence — ${selectedStudent.name ?? selectedStudent.roll}`
              : selectedExam ? selectedExam.name ?? selectedExam.folder
              : "All exam evidence"}
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-soft">
            {selectedStudent
              ? `Recordings, per-second snapshots, flagged frames, PDF report and AI integrity for ${selectedExam?.name ?? ""} · ${selectedStudent.roll}.`
              : selectedExam
                ? `Students with stored evidence under “${selectedExam.folder}” — click one to review their full proctoring record.`
                : "Browse every exam and candidate with stored recordings or snapshots in Cloudflare R2 — even when no attempt row exists in the database."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedStudent && (
            <button onClick={backToStudents} className="inline-flex items-center gap-1.5 border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">
              <FiArrowLeft aria-hidden /> All students
            </button>
          )}
          {selectedExam && !selectedStudent && (
            <button onClick={backToExams} className="inline-flex items-center gap-1.5 border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">
              <FiArrowLeft aria-hidden /> All exams
            </button>
          )}
          {!selectedExam && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search exam…"
              className="w-full border border-line-strong bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest sm:w-64"
            />
          )}
        </div>
      </div>

      {examError && (
        <div className="border border-alert/40 bg-alert/5 p-6 text-[13px] text-alert">
          {examError}
        </div>
      )}

      {/* Level 1 — exams */}
      {!selectedExam && !examError && (
        exams === null ? <Loading /> :
        exams.length === 0 ? (
          <div className="border border-dashed border-line-strong p-12 text-center">
            <p className="font-serif text-xl font-semibold">No evidence in Cloudflare R2 yet</p>
            <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
              Recordings, per-second snapshots, violation frames and PDF reports appear here as soon as candidates sit an exam.
              Folders are named after the exam (“Test-3/…”) so the bucket reads like the console.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visibleExams.map((ex) => (
              <button
                key={ex.folder}
                onClick={() => setSelectedExam(ex)}
                className="group border border-line bg-paper p-5 text-left hover:border-forest"
              >
                <div className="flex items-center justify-between gap-3">
                  <FiFolder aria-hidden className="h-5 w-5 shrink-0 text-forest" />
                  <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Stored as {ex.folder}</span>
                </div>
                <p className="mt-3 truncate font-serif text-lg font-semibold group-hover:text-forest">{ex.name ?? ex.folder}</p>
                <p className="mt-1 text-[12px] text-ink-soft">{ex.batch ?? "Evidence folder"}</p>
              </button>
            ))}
          </div>
        )
      )}

      {/* Level 2 — students of one exam */}
      {selectedExam && !selectedStudent && (
        students === null ? <Loading /> :
        students.length === 0 ? (
          <div className="border border-dashed border-line-strong p-12 text-center font-mono text-[11px] text-ink-soft">
            No student folders under “{selectedExam.folder}” — no artifacts were stored for this exam.
          </div>
        ) : (
          <div className="space-y-2">
            {students.map((s) => (
              <button
                key={s.roll}
                onClick={() => setSelectedStudent(s)}
                className="group flex w-full items-center justify-between gap-4 border border-line bg-paper p-4 text-left hover:border-forest"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-forest/10 font-mono text-[12px] font-semibold text-forest">
                    {(s.name ?? s.roll).slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium group-hover:text-forest">{s.name ?? "Unknown candidate"}</p>
                    <p className="truncate font-mono text-[10px] text-ink-soft">
                      {s.roll}{s.state ? ` · ${s.state === "submitted" ? "Submitted" : s.state === "in_progress" ? "Writing" : s.state === "paused" ? "Paused" : s.state}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 font-mono text-[10px] text-ink-soft">
                  <span className="inline-flex items-center gap-1" title="Recordings"><FiVideo aria-hidden className="h-3.5 w-3.5" /> {s.counts?.recordings ?? 0}</span>
                  <span className="inline-flex items-center gap-1" title="Snapshots"><FiImage aria-hidden className="h-3.5 w-3.5" /> {s.counts?.screenshots ?? 0}</span>
                  <span className={`inline-flex items-center gap-1 ${(s.counts?.violations ?? 0) > 0 ? "text-alert" : ""}`} title="Flagged frames">
                    <FiAlertTriangle aria-hidden className="h-3.5 w-3.5" /> {s.counts?.violations ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-1" title="PDF report"><FiFileText aria-hidden className="h-3.5 w-3.5" /> {s.counts?.report ?? 0}</span>
                  <FiArrowLeft aria-hidden className="h-4 w-4 rotate-180 text-ink-soft transition-transform group-hover:translate-x-0.5" />
                </div>
              </button>
            ))}
          </div>
        )
      )}

      {/* Level 3 — one student's full evidence */}
      {selectedExam && selectedStudent && (
        <StudentEvidence exam={selectedExam} student={selectedStudent} />
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 border border-dashed border-line-strong p-8 font-mono text-[11px] text-ink-soft">
      <span className="h-3 w-3 animate-spin rounded-full border border-forest border-t-transparent" />
      Reading Cloudflare R2…
    </div>
  );
}

function StudentEvidence({ exam, student }: { exam: ExamFolder; student: StudentRow }) {
  const [artifacts, setArtifacts] = useState<R2Artifact[] | null>(null);
  const [violations, setViolations] = useState<ViolationEvent[]>([]);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const [zipMsg, setZipMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [arts, vios] = await Promise.all([
        listArtifactsByPrefix(`${exam.folder}/${student.roll}/`),
        student.attemptId ? listAttemptViolations(student.attemptId) : Promise.resolve([] as ViolationEvent[]),
      ]);
      if (!alive) return;
      setArtifacts(arts ?? []);
      setViolations(vios ?? []);
      const report = (arts ?? []).find((a) => a.kind === "report");
      if (report) {
        const url = await getArtifactObjectUrl(report.key);
        if (alive) setReportUrl(url);
      }
    })();
    return () => { alive = false; };
  }, [exam.folder, student.roll, student.attemptId]);

  const recordings = useMemo(() => (artifacts ?? []).filter((a) => a.kind === "recordings"), [artifacts]);
  const screenshots = useMemo(() => (artifacts ?? []).filter((a) => a.kind === "screenshots").sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? "")), [artifacts]);
  const violationFrames = useMemo(() => (artifacts ?? []).filter((a) => a.kind === "violations").sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? "")), [artifacts]);

  const runZip = async () => {
    if (zipping) return;
    setZipping(true);
    setZipMsg(null);
    try {
      const res = await downloadExamEvidenceZip({
        examId: exam.examId ?? exam.folder,
        examName: exam.name ?? exam.folder,
        folder: exam.folder,
        students: [{ roll: student.roll, name: student.name ?? "" }],
      });
      setZipMsg(res.fileCount === 0
        ? "No recordings or snapshots found in storage for this candidate."
        : `ZIP downloaded · ${res.fileCount} file(s)`);
    } catch (err) {
      console.error("[EvidenceBrowser] ZIP failed:", err);
      setZipMsg("ZIP export failed — storage may be unavailable.");
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="grid gap-8 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-8">
        {/* Recording */}
        <div className="border border-line bg-paper p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Recording</p>
              <h2 className="mt-0.5 font-serif text-lg font-semibold">{student.name ?? student.roll} · {exam.name ?? exam.folder}</h2>
            </div>
            {recordings.length > 0 && (
              <span className="font-mono text-[9px] text-ink-soft">{recordings.length} recording file(s)</span>
            )}
          </div>
          <RecordingReviewer
            examId={exam.examId ?? exam.folder}
            roll={student.roll}
            name={student.name ?? student.roll}
            violations={violations}
            folderOverride={exam.folder}
          />
        </div>

        {/* Snapshot gallery */}
        <div className="border border-line bg-paper p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Snapshots</p>
              <h2 className="mt-0.5 font-serif text-lg font-semibold">Per-second screen captures</h2>
            </div>
            <span className="font-mono text-[9px] text-ink-soft">{screenshots.length} frame(s) · {violationFrames.length} flagged</span>
          </div>
          <SnapshotGallery screenshots={screenshots} violationFrames={violationFrames} />
        </div>
      </div>

      <div className="space-y-4">
        {/* Report PDF */}
        <div className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Proctor report (PDF)</p>
          {reportUrl ? (
            <a href={reportUrl} target="_blank" rel="noreferrer" className="mt-3 flex w-full items-center justify-between border border-forest bg-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">
              <span>Open PDF report</span> <FiFileText aria-hidden />
            </a>
          ) : (
            <p className="mt-3 text-[12px] text-ink-soft">No PDF was generated for this candidate (generated at submit time).</p>
          )}
          <button onClick={() => void runZip()} disabled={zipping} className="mt-3 flex w-full items-center justify-between border border-forest bg-forest px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:cursor-not-allowed disabled:opacity-60">
            <span>{zipping ? "Zipping evidence…" : "Download evidence ZIP"}</span> <FiDownload aria-hidden />
          </button>
          {zipMsg && <p className="mt-2 px-1 font-mono text-[10px] text-ink-soft">{zipMsg}</p>}
        </div>

        {/* AI integrity */}
        {student.attemptId && (
          <AIIntegrityCard attemptId={student.attemptId} />
        )}

        {/* Violation log */}
        {violations.length > 0 && (
          <div className="border border-line bg-paper p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Violation log</p>
            <div className="mt-3 space-y-2">
              {violations.map((v) => (
                <div key={v.id} className="flex items-start justify-between gap-3 border-l-2 border-alert pl-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-ink">{v.description || v.violation_type}</p>
                    <p className="font-mono text-[9px] text-ink-soft">{v.violation_type} · {v.source}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[9px] text-ink-soft">
                    {v.offset_seconds != null ? `@ ${v.offset_seconds}s` : new Date(v.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Filmstrip of per-second screenshots + red-bordered flagged frames. */
function SnapshotGallery({ screenshots, violationFrames }: { screenshots: R2Artifact[]; violationFrames: R2Artifact[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());

  // Sign URLs lazily in small batches so a long exam doesn't mint hundreds of
  // presigned GETs at once.
  useEffect(() => {
    let alive = true;
    const items = [...screenshots.slice(0, 60), ...violationFrames.slice(0, 60)];
    void (async () => {
      const next = new Map<string, string>();
      for (let i = 0; i < items.length; i += 6) {
        const batch = items.slice(i, i + 6);
        const signed = await Promise.all(batch.map((a) => getArtifactObjectUrl(a.key)));
        for (let k = 0; k < batch.length; k++) {
          const u = signed[k];
          if (u) next.set(batch[k].key, u);
        }
        if (alive) setUrls(new Map(next));
      }
    })();
    return () => { alive = false; };
  }, [screenshots, violationFrames]);

  const total = screenshots.length + violationFrames.length;
  if (total === 0) {
    return <p className="border border-dashed border-line-strong p-6 text-center font-mono text-[11px] text-ink-soft">No snapshots were stored for this candidate.</p>;
  }

  const items: { art: R2Artifact; flagged: boolean }[] = [
    ...violationFrames.map((a) => ({ art: a, flagged: true })),
    ...screenshots.slice(0, 54).map((a) => ({ art: a, flagged: false })),
  ];

  const openItem = items.find((i) => i.art.key === openKey) ?? null;

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {items.map(({ art, flagged }) => {
          const url = urls.get(art.key);
          const when = art.lastModified ? new Date(art.lastModified).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
          return (
            <button
              key={art.key}
              onClick={() => url && setOpenKey(art.key)}
              className={`group relative aspect-video overflow-hidden border bg-ink ${flagged ? "border-alert" : "border-line hover:border-forest"} ${url ? "cursor-pointer" : "cursor-wait"}`}
              title={flagged ? `Flagged frame ${art.name} @ ${when}` : `Snapshot @ ${when}`}
            >
              {url ? (
                <img src={url} alt={art.name} className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100" loading="lazy" />
              ) : (
                <span className="flex h-full w-full items-center justify-center font-mono text-[9px] text-paper/30">…</span>
              )}
              {flagged && <span className="absolute left-1 top-1 bg-alert px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-paper">Flag</span>}
              {when && <span className="absolute bottom-1 right-1 bg-ink/75 px-1 font-mono text-[8px] text-paper">{when}</span>}
            </button>
          );
        })}
      </div>
      {screenshots.length > 54 && (
        <p className="mt-2 font-mono text-[9px] text-ink-soft">
          Showing the 54 most recent of {screenshots.length} snapshots — download the ZIP for the complete set.
        </p>
      )}
      {violationFrames.length > 60 && (
        <p className="mt-1 font-mono text-[9px] text-ink-soft">Showing the 60 most recent of {violationFrames.length} flagged frames.</p>
      )}

      {openItem && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/90 p-6" onClick={() => setOpenKey(null)}>
          <div className="relative max-h-full max-w-5xl border border-line bg-paper p-3" onClick={(e) => e.stopPropagation()}>
            <img
              src={urls.get(openItem.art.key) ?? ""}
              alt={openItem.art.name}
              className="max-h-[75vh] w-full object-contain"
            />
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="min-w-0 truncate font-mono text-[10px] text-ink-soft">
                {openItem.flagged ? `Flagged frame · ${openItem.art.name}` : openItem.art.name}
                {openItem.art.lastModified ? ` · ${new Date(openItem.art.lastModified).toLocaleString()}` : ""}
              </p>
              <a
                href={urls.get(openItem.art.key) ?? ""}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-forest underline-offset-2 hover:underline"
              >
                Open full size
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}