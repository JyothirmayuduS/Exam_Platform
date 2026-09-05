// Recording review — plays a candidate's Cloudflare R2 recording with the
// violation events drawn as RED markers on the seek bar. Clicking a marker (or
// a row in the violation log) jumps the video straight to the flagged moment.
//
// Data sources:
//   • violations: violation_events rows (offset_seconds = seconds into the
//     exam; when a marker appears before the recording duration is known the
//     position is estimated from the recording file time instead)
//   • artifacts: ${examId}/${roll}/recordings + /violations + /report listed
//     from Cloudflare R2 (examStorage.listStudentArtifacts)
//
// Two playback modes:
//   • "file"  — a finished recording_….webm exists (normal submitted exam).
//   • "parts" — no finished video (browser crashed / session abandoned), but
//     crash-safe 10 s segments were uploaded live. Segments are played one
//     after another over ONE continuous timeline whose duration grows as each
//     segment loads, so a full merged preview is ALWAYS available. Red
//     violation markers keep working across the segment boundaries.

import { useEffect, useMemo, useRef, useState } from "react";
import { FiDownload, FiUploadCloud } from "react-icons/fi";
import { listStudentArtifacts, getArtifactObjectUrl, uploadArtifactBlob } from "../lib/examStorage";
import type { ViolationEvent } from "../lib/examApi";

function clock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "00:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type PartItem = { key: string; url: string };

type LoadingArtifacts = {
  /** Finished full video URL (normal submitted exam). */
  recordingUrl: string | null;
  /** Crash-safe segments to stitch when no finished video exists. */
  parts: PartItem[];
  /** True when the URL above is a parts-assembled preview, not one file. */
  rebuilt: boolean;
  posterUrl: string | null;
  snapshotUrls: string[];
  reportUrl: string | null;
  status: "loading" | "ready" | "empty" | "error";
};

function useRecordingArtifacts(examId: string, roll: string, reloadKey = 0): LoadingArtifacts {
  const [state, setState] = useState<LoadingArtifacts>({
    recordingUrl: null,
    parts: [],
    rebuilt: false,
    posterUrl: null,
    snapshotUrls: [],
    reportUrl: null,
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    if (!examId || !roll) {
      setState((s) => ({ ...s, status: "empty" }));
      return;
    }
    setState((s) => ({ ...s, status: "loading", recordingUrl: null, parts: [], snapshotUrls: [], reportUrl: null }));
    void (async () => {
      try {
        const arts = await listStudentArtifacts(examId, roll);
        if (cancelled) return;
        if (!arts || arts.length === 0) {
          setState((s) => ({ ...s, status: "empty" }));
          return;
        }
        // Crash-proof parts live under recordings/parts/ — chunk fragments of
        // ONE continuous recorder, excluded from the finished-file pick.
        const parts = arts
          .filter((a) => a.kind === "recordings" && a.key.includes("/parts/"))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const recordings = arts
          .filter((a) => a.kind === "recordings" && !a.key.includes("/parts/"))
          .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
        const snaps = arts
          .filter((a) => a.kind === "violations")
          .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
        const report = arts.find((a) => a.kind === "report") ?? null;

        // Prefer the full-exam webm, fall back to the screen / camera stream.
        const chosen =
          recordings.find((a) => a.name.startsWith("recording_")) ??
          recordings.find((a) => a.name.startsWith("screen_")) ??
          recordings.find((a) => a.name.startsWith("camera_")) ??
          recordings[0] ??
          null;
        const poster = snaps[0] ?? null;

        const [recUrl, posterUrl] = await Promise.all([
          chosen ? getArtifactObjectUrl(chosen.key) : Promise.resolve<string | null>(null),
          poster ? getArtifactObjectUrl(poster.key) : Promise.resolve<string | null>(null),
        ]);
        const snapshotUrls = await Promise.all(
          snaps.slice(0, 8).map((a) => getArtifactObjectUrl(a.key)),
        );
        const reportUrl = report ? await getArtifactObjectUrl(report.key) : null;

        // No finished video (crash before submit?) — stitch the live-uploaded
        // segments into a continuous preview. Sign every segment URL up front.
        let partsWithUrl: PartItem[] = [];
        if (!recUrl && parts.length > 0) {
          const urls = await Promise.all(parts.slice(0, 720).map((a) => getArtifactObjectUrl(a.key)));
          partsWithUrl = parts
            .slice(0, 720)
            .map((a, i) => ({ key: a.key, url: urls[i] ?? "" }))
            .filter((p): p is PartItem => Boolean(p.url));
        }
        if (cancelled) return;
        setState({
          recordingUrl: recUrl,
          parts: partsWithUrl,
          rebuilt: partsWithUrl.length > 0,
          posterUrl,
          snapshotUrls: snapshotUrls.filter((u): u is string => !!u),
          reportUrl,
          status: recUrl || partsWithUrl.length > 0 ? "ready" : "empty",
        });
      } catch (err) {
        console.warn("[RecordingReview] artifact load failed:", err);
        if (!cancelled) setState((s) => ({ ...s, status: "error" }));
      }
    })();
    return () => { cancelled = true; };
  }, [examId, roll, reloadKey]);

  return state;
}

function sortViolations(violations: ViolationEvent[]): ViolationEvent[] {
  return [...violations].sort((a, b) => {
    const ao = a.offset_seconds ?? Number.MAX_SAFE_INTEGER;
    const bo = b.offset_seconds ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/** Median of the durations we know — used to estimate not-yet-loaded parts. */
function estimatePartSeconds(known: number[]): number {
  if (known.length === 0) return 10; // recorder emits a chunk every ~10 s
  const sorted = [...known].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 10;
}

export default function RecordingReviewer({
  examId,
  roll,
  name,
  violations,
}: {
  examId: string;
  roll: string;
  name: string;
  violations: ViolationEvent[];
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const artifacts = useRecordingArtifacts(examId, roll, reloadKey);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // ── Parts-assembly timeline ──────────────────────────────────────────────
  // plays segments in order over one continuous timeline. `durations[i]` is
  // set once segment i's metadata loads; unknown segments are estimated so the
  // seek bar stays meaningful from the start.
  const partMode = !artifacts.recordingUrl && artifacts.parts.length > 0;
  const [partIdx, setPartIdx] = useState(0);
  const durationsRef = useRef<(number | null)[]>([]);
  const [, bump] = useState(0);
  // True right after one segment ends and we switch src — lets the SAME
  // <video> element auto-continue (the element already holds play permission).
  const autoAdvanceRef = useRef(false);
  const seekAfterLoadRef = useRef<number | null>(null);

  const startsAt = useMemo(() => {
    if (!partMode) return [0];
    const est = estimatePartSeconds(durationsRef.current.filter((d): d is number => d != null));
    let acc = 0;
    return artifacts.parts.map((_, i) => {
      const s = acc;
      acc += durationsRef.current[i] ?? est;
      return s;
    });
  }, [partMode, artifacts.parts, bump, artifacts]);

  const partTotal = useMemo(() => {
    if (!partMode) return null;
    const est = estimatePartSeconds(durationsRef.current.filter((d): d is number => d != null));
    let acc = 0;
    for (let i = 0; i < artifacts.parts.length; i++) acc += durationsRef.current[i] ?? est;
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partMode, artifacts.parts, bump]);

  // When the mode changes (different recording loaded) reset playback state.
  useEffect(() => {
    setDuration(null);
    setCurrent(0);
    setPlaying(false);
    setLoadError(false);
    setPartIdx(0);
    durationsRef.current = [];
    const el = videoRef.current;
    if (el) { el.currentTime = 0; el.removeAttribute("src"); el.load(); }
  }, [artifacts.recordingUrl, partMode]);

  const visibleDuration = partMode ? (partTotal ?? duration) : duration;
  const videoSrc = partMode ? artifacts.parts[partIdx]?.url : artifacts.recordingUrl;

  const recordDuration = (d: number) => {
    if (!partMode) { setDuration(d); return; }
    const i = partIdx;
    if (durationsRef.current[i] !== d) {
      durationsRef.current[i] = d;
      setDuration(partTotal ?? 0);
      bump((v) => v + 1);
    }
  };

  const seekTo = (sec: number) => {
    const el = videoRef.current;
    const total = partMode ? partTotal : duration;
    if (!el || !total) return;
    const target = Math.min(total, Math.max(0, sec));
    if (!partMode) {
      el.currentTime = target;
      void el.play().catch(() => undefined);
      return;
    }
    // Find the segment containing `target`, switch to it, then seek within it.
    let idx = artifacts.parts.length - 1;
    for (let i = 0; i < artifacts.parts.length; i++) {
      const next = i + 1 < artifacts.parts.length ? (startsAt[i + 1] ?? Infinity) : Infinity;
      if (target >= startsAt[i] && target < next) { idx = i; break; }
    }
    const within = Math.max(0, target - startsAt[idx]);
    if (idx !== partIdx) {
      // src swap re-applies the seek once the new segment's metadata loads.
      seekAfterLoadRef.current = within;
      setPartIdx(idx);
    } else {
      el.currentTime = within;
      void el.play().catch(() => undefined);
    }
  };

  const sorted = useMemo(() => sortViolations(violations), [violations]);

  const markers = useMemo(
    () =>
      sorted
        .map((v) => {
          const t = v.offset_seconds ?? 0;
          return {
            v,
            seconds: Math.max(0, t),
            label: v.description || v.violation_type,
            severity: v.severity,
            created: v.created_at,
          };
        })
        .sort((a, b) => a.seconds - b.seconds),
    [sorted],
  );

  const markerStyle = (seconds: number) => {
    const d = visibleDuration;
    const pct = d && d > 0 ? Math.min(99.5, Math.max(0, (seconds / d) * 100)) : 0;
    return { left: `${pct}%` };
  };

  const partCountLabel =
    artifacts.parts.length > 0
      ? ` · ${artifacts.parts.length} crash-safe segment${artifacts.parts.length === 1 ? "" : "s"}`
      : "";

  // ── Repair: when no finished recording_….webm exists (session abandoned or
  // the submit-time upload didn't finish), stitch the crash-safe segments into
  // one full video HERE and store it in Cloudflare R2 so the exam has a single
  // full-length recording object — not just fragments.
  const [saving, setSaving] = useState(false);
  const [saveDone, setSaveDone] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const saveMergedVideo = async () => {
    if (!partMode || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveDone(false);
    setMergeMsg(null);
    try {
      const chunks: Blob[] = [];
      for (let i = 0; i < artifacts.parts.length; i++) {
        setMergeMsg(`Downloading crash-safe segment ${i + 1} of ${artifacts.parts.length}…`);
        const res = await fetch(artifacts.parts[i].url);
        if (!res.ok) throw new Error(`Segment ${i + 1} download failed (HTTP ${res.status})`);
        chunks.push(await res.blob());
      }
      const merged = new Blob(chunks, { type: "video/webm" });
      setMergeMsg("Uploading full recording to Cloudflare R2…");
      const key = `${examId}/${roll}/recordings/recording_rebuilt_${Date.now()}.webm`;
      const stored = await uploadArtifactBlob(key, merged, "video/webm");
      if (!stored) throw new Error("Cloudflare upload did not confirm");
      setSaveDone(true);
      setMergeMsg("Full recording saved to Cloudflare R2");
      setReloadKey((k) => k + 1); // reload — the finished file is now preferred
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden border border-line bg-[#1F231D]">
        {artifacts.status === "loading" && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/60">Loading recording from Cloudflare…</p>
        )}
        {artifacts.rebuilt && (
          <span className="absolute left-3 top-3 z-10 border border-amber/40 bg-ink/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber">
            Live preview · merged from {artifacts.parts.length} crash-safe segment{artifacts.parts.length === 1 ? "" : "s"}
          </span>
        )}
        {artifacts.status !== "loading" && videoSrc && (
          <video
            ref={videoRef}
            src={videoSrc}
            poster={artifacts.posterUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d)) recordDuration(d);
              setLoadError(false);
              if (partMode) {
                // Apply a pending cross-segment seek, then play.
                const target = seekAfterLoadRef.current;
                const advance = autoAdvanceRef.current;
                seekAfterLoadRef.current = null;
                autoAdvanceRef.current = false;
                if (target != null) {
                  try { e.currentTarget.currentTime = Math.max(0, Math.min(target, d)); } catch { /* ignore */ }
                }
                if (target != null || advance) {
                  void e.currentTarget.play().catch(() => undefined);
                }
              }
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              const total = partMode ? partTotal : null;
              const abs = partMode && total ? startsAt[partIdx] + t : t;
              setCurrent((prev) => (Math.abs(prev - abs) > 0.25 ? abs : prev));
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              // Advance to the next crash-safe segment (continuous playback).
              if (partMode && partIdx + 1 < artifacts.parts.length) {
                autoAdvanceRef.current = true;
                setPartIdx((i) => i + 1);
              } else {
                setPlaying(false);
              }
            }}
            onError={() => setLoadError(true)}
          />
        )}
        {artifacts.status === "ready" && !videoSrc && !loadError && (
          <p className="px-6 text-center font-mono text-[10px] uppercase tracking-widest text-paper/60">
            No playable recording found
          </p>
        )}
        {artifacts.status === "empty" && (
          <div className="flex flex-col items-center px-6 text-center">
            {artifacts.posterUrl ? (
              <img src={artifacts.posterUrl} alt="" className="max-h-48 object-contain opacity-80" />
            ) : (
              <span className="font-serif text-3xl text-paper/20">{name.split(" ").map((x) => x[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}</span>
            )}
            <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-paper/50">
              No artifacts stored for {roll} (Cloudflare R2 / Supabase backup)
            </p>
          </div>
        )}
        {artifacts.status === "error" && (
          <p className="px-6 text-center font-mono text-[10px] uppercase tracking-widest text-alert">
            Could not read the recording from Cloudflare R2 or the Supabase backup bucket.
          </p>
        )}
        {loadError && videoSrc && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/85 px-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-widest text-alert">
              Recording could not be played — it may still be uploading.
            </p>
          </div>
        )}

        <span className="absolute right-2 top-2 bg-ink/75 px-2 py-1 font-mono text-[9px] uppercase text-paper">
          {videoSrc ? `REC · ${clock(current)}${visibleDuration ? ` / ${clock(visibleDuration)}` : ""}` : "NO RECORDING"}
        </span>
        {playing && <span className="absolute left-2 top-2 h-2 w-2 animate-pulse rounded-full bg-alert" />}
      </div>

      {/* Seek bar with RED violation markers */}
      <div className="space-y-2">
        <div
          className="relative h-2 w-full cursor-pointer bg-ink/15"
          onClick={(e) => {
            const total = partMode ? partTotal : duration;
            if (!total) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            seekTo(pct * total);
          }}
        >
          <div
            className="absolute left-0 top-0 h-full bg-forest"
            style={{ width: visibleDuration ? `${Math.min(100, (current / visibleDuration) * 100)}%` : "0%" }}
          />
          {visibleDuration && markers.map((m) => (
            <button
              key={m.v.id}
              title={`${m.label} @ ${clock(m.seconds)}`}
              onClick={(e) => { e.stopPropagation(); seekTo(m.seconds); }}
              className={`absolute top-0 h-full w-1.5 -translate-x-1/2 ${m.severity === "critical" || m.severity === "high" ? "bg-alert" : "bg-amber"}`}
              style={markerStyle(m.seconds)}
            />
          ))}
        </div>
        <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-ink-soft">
          <span>{markers.length > 0 ? `${markers.length} violation marker(s) in red` : "No violations on this timeline"}</span>
          <span>{clock(current)} {visibleDuration ? `/ ${clock(visibleDuration)}` : ""}{partCountLabel}</span>
        </div>
      </div>

      {/* Repair panel: no finished video yet — offer to persist the full merge */}
      {partMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-amber/40 bg-amber/[0.05] px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-amber">No finished recording file</p>
            <p className="mt-1 text-[12px] text-ink-soft">
              {saveDone
                ? "Full video has been saved to Cloudflare R2 and will be used from now on."
                : "This exam has crash-safe segments only — stitch them into one full-length recording and store it in Cloudflare R2."}
            </p>
          </div>
          <button
            onClick={() => void saveMergedVideo()}
            disabled={saving || saveDone}
            className="inline-flex items-center gap-1.5 border border-amber px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-amber transition-colors hover:bg-amber/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiUploadCloud aria-hidden />
            {saving ? "Merging…" : saveDone ? "Saved ✓" : `Save full video (${artifacts.parts.length} seg)`}
          </button>
        </div>
      )}
      {mergeMsg && (
        <p className="font-mono text-[10px] text-ink-soft">{mergeMsg}</p>
      )}
      {saveError && (
        <p className="font-mono text-[10px] text-alert">Could not save full video — {saveError}. The segments above still play as one merged preview.</p>
      )}

      {/* Violation log with jump buttons */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Violation log</p>
        <div className="mt-2 space-y-2">
          {markers.length === 0 && (
            <p className="border-l-2 border-success bg-success/5 px-3 py-2 text-[12px] text-ink-soft">
              No proctoring flags recorded for this candidate.
            </p>
          )}
          {markers.map((m, i) => (
            <div key={m.v.id} className="flex items-center justify-between gap-3 border-l-2 border-alert bg-alert/[0.04] p-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{m.label}</p>
                <p className="mt-0.5 font-mono text-[10px] text-ink-soft">
                  #{i + 1} · {m.v.violation_type} · {m.v.severity} · {new Date(m.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <button
                disabled={!visibleDuration}
                onClick={() => seekTo(m.seconds)}
                className="shrink-0 border border-alert/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-alert hover:bg-alert/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Jump to {clock(m.seconds)}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Violation snapshots + report */}
      {(artifacts.snapshotUrls.length > 0 || artifacts.reportUrl) && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Evidence · Cloudflare R2</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {artifacts.snapshotUrls.slice(0, 6).map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="border border-line bg-paper-raised p-0.5 hover:border-alert">
                <img src={u} alt={`flagged frame ${i + 1}`} className="h-16 w-24 object-cover" />
              </a>
            ))}
            {artifacts.reportUrl && (
              <a
                href={artifacts.reportUrl}
                target="_blank"
                rel="noreferrer"
                className="border border-forest bg-forest/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-forest/10"
              >
                <FiDownload aria-hidden /> Open PDF report
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Full-screen modal used from the teacher evaluation flow. */
export function RecordingReviewModal({
  examId,
  roll,
  name,
  violations,
  onClose,
}: {
  examId: string;
  roll: string;
  name: string;
  violations: ViolationEvent[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden border border-line bg-paper shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-paper-raised px-5 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Recording review</p>
            <h3 className="truncate font-serif text-lg font-semibold">{name} <span className="font-mono text-[11px] font-normal text-ink-soft">{roll}</span></h3>
          </div>
          <button onClick={onClose} className="border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <RecordingReviewer examId={examId} roll={roll} name={name} violations={violations} />
        </div>
      </div>
    </div>
  );
}
