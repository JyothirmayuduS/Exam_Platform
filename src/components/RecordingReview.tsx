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

import { useEffect, useMemo, useRef, useState } from "react";
import { FiDownload } from "react-icons/fi";
import { listStudentArtifacts, getArtifactObjectUrl } from "../lib/examStorage";
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

type LoadingArtifacts = {
  recordingUrl: string | null;
  posterUrl: string | null;
  snapshotUrls: string[];
  reportUrl: string | null;
  rebuilt: boolean;
  status: "loading" | "ready" | "empty" | "error";
};

function useRecordingArtifacts(examId: string, roll: string): LoadingArtifacts {
  const [state, setState] = useState<LoadingArtifacts>({
    recordingUrl: null,
    posterUrl: null,
    snapshotUrls: [],
    reportUrl: null,
    rebuilt: false,
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    if (!examId || !roll) {
      setState((s) => ({ ...s, status: "empty" }));
      return;
    }
    setState((s) => ({ ...s, status: "loading", recordingUrl: null, snapshotUrls: [], reportUrl: null }));
    void (async () => {
      try {
        const arts = await listStudentArtifacts(examId, roll);
        if (cancelled) return;
        if (!arts || arts.length === 0) {
          setState((s) => ({ ...s, status: "empty" }));
          return;
        }
        // Crash-proof parts live under recordings/parts/ — they are chunk
        // fragments of one continuous recording, excluded from the normal pick.
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
        const pick = (list: typeof recordings) =>
          list.find((a) => a.name.startsWith("recording_")) ??
          list.find((a) => a.name.startsWith("screen_")) ??
          list.find((a) => a.name.startsWith("camera_")) ??
          list[0] ??
          null;

        const chosen = pick(recordings);
        const poster = snaps[0] ?? null;

        const [recUrl, posterUrl] = await Promise.all([
          chosen ? getArtifactObjectUrl(chosen.key) : Promise.resolve<string | null>(null),
          poster ? getArtifactObjectUrl(poster.key) : Promise.resolve<string | null>(null),
        ]);
        const snapshotUrls = await Promise.all(
          snaps.slice(0, 8).map((a) => getArtifactObjectUrl(a.key)),
        );
        const reportUrl = report ? await getArtifactObjectUrl(report.key) : null;

        // No finished video (browser crashed before submit?) — rebuild it from
        // the live-uploaded parts by fetching them in order and concatenating.
        // Parts come from ONE continuous recorder, so byte-concatenation is the
        // same assembly the recorder would have done in memory.
        let rebuiltUrl: string | null = null;
        if (!recUrl && parts.length > 0) {
          const partUrls = (
            await Promise.all(parts.slice(0, 2000).map((a) => getArtifactObjectUrl(a.key)))
          ).filter((u): u is string => !!u);
          const concat: Blob[] = [];
          for (const u of partUrls) {
            try {
              const r = await fetch(u);
              if (r.ok) concat.push(await r.blob());
            } catch { /* skip a lost part */ }
          }
          if (concat.length > 0) {
            rebuiltUrl = URL.createObjectURL(new Blob(concat, { type: "video/webm" }));
          }
        }
        const finalRecUrl = recUrl ?? rebuiltUrl;
        if (cancelled) return;
        setState({
          recordingUrl: finalRecUrl,
          posterUrl: posterUrl,
          snapshotUrls: snapshotUrls.filter((u): u is string => !!u),
          reportUrl,
          rebuilt: rebuiltUrl !== null,
          status: finalRecUrl ? "ready" : snaps.length > 0 ? "empty" : "empty",
        });
      } catch (err) {
        console.warn("[RecordingReview] artifact load failed:", err);
        if (!cancelled) setState((s) => ({ ...s, status: "error" }));
      }
    })();
    return () => { cancelled = true; };
  }, [examId, roll]);

  return state;
}

function sortViolations(violations: ViolationEvent[]): ViolationEvent[] {
  return [...violations].sort((a, b) => {
    const ao = a.offset_seconds ?? Number.MAX_SAFE_INTEGER;
    const bo = b.offset_seconds ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
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
  const artifacts = useRecordingArtifacts(examId, roll);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Reset playback state whenever a different recording is loaded.
  useEffect(() => {
    setDuration(null);
    setCurrent(0);
    setPlaying(false);
    setLoadError(false);
    const el = videoRef.current;
    if (el) el.currentTime = 0;
  }, [artifacts.recordingUrl]);

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

  const seekTo = (sec: number) => {
    const el = videoRef.current;
    if (!el || !duration) return;
    el.currentTime = Math.min(duration, Math.max(0, sec));
    void el.play().catch(() => undefined);
  };

  const markerStyle = (seconds: number) => {
    const d = duration ?? (artifacts.recordingUrl ? 1 : 1);
    const pct = d > 0 ? Math.min(99.5, Math.max(0, (seconds / d) * 100)) : 0;
    return { left: `${pct}%` };
  };

  return (
    <div className="space-y-4">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden border border-line bg-[#1F231D]">
        {artifacts.status === "loading" && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/60">Loading recording from Cloudflare…</p>
        )}
        {artifacts.rebuilt && artifacts.recordingUrl && (
          <span className="absolute left-3 top-3 z-10 border border-amber/40 bg-ink/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber">
            Rebuilt from crash-safe parts
          </span>
        )}
        {artifacts.status !== "loading" && artifacts.recordingUrl && (
          <video
            ref={videoRef}
            src={artifacts.recordingUrl}
            poster={artifacts.posterUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              setCurrent((prev) => (Math.abs(prev - t) > 0.2 ? t : prev));
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setLoadError(true)}
          />
        )}
        {artifacts.status === "ready" && !artifacts.recordingUrl && !loadError && (
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
        {loadError && artifacts.recordingUrl && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/85 px-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-widest text-alert">
              Recording could not be played — it may still be uploading.
            </p>
          </div>
        )}

        <span className="absolute right-2 top-2 bg-ink/75 px-2 py-1 font-mono text-[9px] uppercase text-paper">
          {artifacts.recordingUrl ? `REC · ${clock(current)}${duration ? ` / ${clock(duration)}` : ""}` : "NO RECORDING"}
        </span>
        {playing && <span className="absolute left-2 top-2 h-2 w-2 animate-pulse rounded-full bg-alert" />}
      </div>

      {/* Seek bar with RED violation markers */}
      <div className="space-y-2">
        <div
          className="relative h-2 w-full cursor-pointer bg-ink/15"
          onClick={(e) => {
            if (!duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            seekTo(pct * duration);
          }}
        >
          <div
            className="absolute left-0 top-0 h-full bg-forest"
            style={{ width: duration ? `${(current / duration) * 100}%` : "0%" }}
          />
          {duration && markers.map((m) => (
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
          <span>{duration ? clock(current) : ""} {duration ? `/ ${clock(duration)}` : ""}</span>
        </div>
      </div>

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
                disabled={!duration}
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
