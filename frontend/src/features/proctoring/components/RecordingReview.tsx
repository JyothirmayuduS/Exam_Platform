// Recording review — plays a candidate's Cloudflare R2 recording with the
// violation events drawn as RED markers on the seek bar. Clicking a marker (or
// a row in the violation log) jumps the video straight to the flagged moment.
//
// Data sources:
//   • violations: violation_events rows. A marker sits at the violation's
//     wall-clock time on the recording's timeline (created_at minus the time
//     the first recorder started), so it stays on the real exam moment even
//     after a page reload restarted the recorder. Recordings without
//     wall-clock piece names fall back to offset_seconds.
//   • artifacts: ${examFolder}/${roll}/recordings + /violations + /report listed
//     from Cloudflare R2 (examStorage.listStudentArtifacts), where examFolder is
//     the slug of the exam NAME (legacy ${examId}/ folders are read too).
//
// Two playback modes:
//   • pieces — the normal case. The exam is stored ONLY as 10 s pieces
//     (parts/exam_* for the camera, parts/screen_* for the screen; older
//     kiosks wrote seg_* / camera_*). They play as ONE full-length video
//     (piecePlayer): loaded around the playhead, reloaded on any seek, with
//     links re-signed before they expire. Pieces that cannot be signed or
//     fetched are listed under the video.
//   • file — a finished recording_….webm from older exam browsers; its link
//     is re-signed before it expires, keeping the playback position.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiDownload } from "react-icons/fi";
import { listStudentArtifacts, getArtifactObjectUrl, getArtifactUrls, type R2Artifact } from "@/shared/services/examStorage";
import type { ViolationEvent } from "@/shared/data/examApi";
import { pieceTimeline, sortedParts, type PieceTimeline } from "@/shared/services/recordingParts";
import { createPieceFetcher, describeMissing, joinPieces, LINK_REFRESH_MARGIN_SEC, LINK_TTL_SEC, type MissingPiece } from "@/shared/services/pieceFetch";
import { createBlobSink } from "@/shared/services/zipStream";
import { startPiecePlayer, type PlayerStatus } from "@/features/proctoring/services/piecePlayer";

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

export type PartSource = "camera" | "screen";

/** Screenshots, flagged frames and the PDF are signed for long enough to outlast a review session. */
const EVIDENCE_LINK_SEC = 12 * 3600;

type LoadingArtifacts = {
  /** Finished full video (older exam browsers), used when no pieces exist. */
  fileKey: string | null;
  /** Camera pieces (parts/exam_*, or older seg_* / camera_*). */
  camera: PieceTimeline<R2Artifact> | null;
  /** Screen pieces (parts/screen_*). */
  screen: PieceTimeline<R2Artifact> | null;
  posterUrl: string | null;
  snapshotUrls: string[];
  /** Periodic screenshots (from the screenshots/ folder). */
  screenshotTimelineUrls: { url: string; timestamp: number }[];
  reportKey: string | null;
  status: "loading" | "ready" | "empty" | "error";
};

const EMPTY: LoadingArtifacts = {
  fileKey: null, camera: null, screen: null, posterUrl: null, snapshotUrls: [],
  screenshotTimelineUrls: [], reportKey: null, status: "loading",
};

function useRecordingArtifacts(examId: string, roll: string, reloadKey = 0, folderOverride?: string): LoadingArtifacts {
  const [state, setState] = useState<LoadingArtifacts>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    if (!examId || !roll) {
      setState({ ...EMPTY, status: "empty" });
      return;
    }
    setState(EMPTY);
    void (async () => {
      try {
        const arts = await listStudentArtifacts(examId, roll, folderOverride);
        if (cancelled) return;
        if (!arts) { setState({ ...EMPTY, status: "error" }); return; }
        if (arts.length === 0) { setState({ ...EMPTY, status: "empty" }); return; }
        // Each recorder family is its own timeline and must never be
        // interleaved: mixing them made the review video jump between
        // recorders and stop early.
        const cameraPieces = [sortedParts(arts, "exam"), sortedParts(arts, "seg"), sortedParts(arts, "camera")].find((l) => l.length > 0) ?? [];
        const screenPieces = sortedParts(arts, "screen");
        const recordings = arts
          .filter((a) => a.kind === "recordings" && !a.key.includes("/parts/"))
          .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
        const snaps = arts
          .filter((a) => a.kind === "violations")
          .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
        const report = arts.find((a) => a.kind === "report") ?? null;
        const chosen =
          recordings.find((a) => a.name.startsWith("recording_")) ??
          recordings.find((a) => a.name.startsWith("screen_")) ??
          recordings.find((a) => a.name.startsWith("camera_")) ??
          recordings[0] ??
          null;
        const screenshotArts = arts
          .filter((a) => a.kind === "screenshots" && a.name.startsWith("snap_"))
          .sort((a, b) => Number(a.name.match(/snap_(\d+)\.jpg$/)?.[1] ?? 0) - Number(b.name.match(/snap_(\d+)\.jpg$/)?.[1] ?? 0))
          .slice(0, 120); // Cap at 120 to avoid signing too many URLs
        const evidenceKeys = [...snaps.slice(0, 8).map((a) => a.key), ...screenshotArts.map((a) => a.key)];
        const signed = evidenceKeys.length ? await getArtifactUrls(evidenceKeys, EVIDENCE_LINK_SEC) : new Map<string, string>();
        const signOne = async (key: string) => signed.get(key) ?? await getArtifactObjectUrl(key, EVIDENCE_LINK_SEC);
        const snapshotUrls = await Promise.all(snaps.slice(0, 8).map((a) => signOne(a.key)));
        const screenshotTimeline: { url: string; timestamp: number }[] = [];
        for (const a of screenshotArts) {
          const url = await signOne(a.key);
          if (url) screenshotTimeline.push({ url, timestamp: Number(a.name.match(/snap_(\d+)\.jpg$/)?.[1] ?? 0) });
        }
        if (cancelled) return;
        const camera = cameraPieces.length ? pieceTimeline(cameraPieces) : null;
        const screen = screenPieces.length ? pieceTimeline(screenPieces) : null;
        const havePieces = !!camera || !!screen;
        setState({
          fileKey: havePieces ? null : chosen?.key ?? null,
          camera,
          screen,
          posterUrl: snapshotUrls[0] ?? null,
          snapshotUrls: snapshotUrls.filter((u): u is string => !!u),
          screenshotTimelineUrls: screenshotTimeline,
          reportKey: report?.key ?? null,
          status: havePieces || chosen ? "ready" : "empty",
        });
      } catch (err) {
        console.warn("[RecordingReview] artifact load failed:", err);
        if (!cancelled) setState({ ...EMPTY, status: "error" });
      }
    })();
    return () => { cancelled = true; };
  }, [examId, roll, reloadKey, folderOverride]);

  return state;
}

/** A signed link for one stored file, signed again before it expires. */
function useRefreshingUrl(key: string | null, retry: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sign = async () => {
      const u = await getArtifactObjectUrl(key, LINK_TTL_SEC);
      if (cancelled) return;
      setUrl(u);
      timer = setTimeout(() => void sign(), (LINK_TTL_SEC - LINK_REFRESH_MARGIN_SEC) * 1000);
    };
    void sign();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, retry]);
  return url;
}

function sortViolations(violations: ViolationEvent[]): ViolationEvent[] {
  return [...violations].sort((a, b) => {
    const ao = a.offset_seconds ?? Number.MAX_SAFE_INTEGER;
    const bo = b.offset_seconds ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function MissingList({ missing, label }: { missing: MissingPiece[]; label: string }) {
  if (missing.length === 0) return null;
  const lines = describeMissing(missing);
  return (
    <div className="border-l-2 border-alert bg-alert/5 px-3 py-2 text-[12px] text-alert">
      <p className="font-medium">
        {missing.length} piece{missing.length === 1 ? "" : "s"} of this {label} could not be loaded. The video skips {missing.length === 1 ? "this part" : "these parts"} of the exam:
      </p>
      <ul className="mt-1 font-mono text-[10px]">
        {lines.slice(0, 6).map((l) => <li key={l}>{l}</li>)}
        {lines.length > 6 && <li>…and {lines.length - 6} more</li>}
      </ul>
    </div>
  );
}

export default function RecordingReviewer({
  examId,
  roll,
  name,
  violations,
  /** Exact stored exam folder (e.g. "Test-3") — skips DB name resolution so the
   *  reviewer reads the artifacts the evidence archive actually found. */
  folderOverride,
}: {
  examId: string;
  roll: string;
  name: string;
  violations: ViolationEvent[];
  folderOverride?: string;
}) {
  const [reloadKey] = useState(0);
  const artifacts = useRecordingArtifacts(examId, roll, reloadKey, folderOverride);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; setVideoEl(el); }, []);
  const [duration, setDuration] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [source, setSource] = useState<PartSource>("camera");
  const activeSource: PartSource =
    source === "camera" && !artifacts.camera ? "screen"
      : source === "screen" && !artifacts.screen ? "camera"
        : source;
  const timeline = activeSource === "screen" ? artifacts.screen : artifacts.camera;
  const partMode = !!timeline;
  const hasBothSources = !!artifacts.camera && !!artifacts.screen;
  const fetcher = useMemo(
    () => (timeline ? createPieceFetcher({ keys: timeline.pieces.map((p) => p.key) }) : null),
    [timeline],
  );

  // A video that fails mid-playback is rebuilt at the same position (twice)
  // before an error is shown; a finished file is re-signed and retried.
  const [attempt, setAttempt] = useState(0);
  const resumeAt = useRef(0);
  const [player, setPlayer] = useState<PlayerStatus | null>(null);
  const [joinedUrl, setJoinedUrl] = useState<string | null>(null);
  const fileUrl = useRefreshingUrl(partMode ? null : artifacts.fileKey, attempt);

  useEffect(() => {
    setAttempt(0);
    resumeAt.current = 0;
  }, [timeline, artifacts.fileKey]);

  // Reset the player state when the source changes.
  useEffect(() => {
    setDuration(null);
    setCurrent(0);
    setPlaying(false);
    setLoadError(false);
  }, [timeline, artifacts.fileKey]);

  // Pieces: stream them through Media Source around the playhead.
  useEffect(() => {
    setPlayer(null);
    setJoinedUrl(null);
    if (!videoEl || !timeline || !fetcher) return;
    const handle = startPiecePlayer({ video: videoEl, timeline, fetcher, onStatus: setPlayer, startAt: resumeAt.current });
    return () => handle.destroy();
  }, [videoEl, timeline, fetcher, attempt]);

  // Browsers that cannot stream the pieces get them joined into one file.
  const needsFile = !!player?.needsFile;
  useEffect(() => {
    if (!needsFile || !timeline || !fetcher || !videoEl) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      const sink = createBlobSink("video/webm");
      const res = await joinPieces({ timeline, fetcher, write: sink.write });
      const blob = await sink.close();
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setJoinedUrl(url);
      setPlayer((p) => (p ? { ...p, missing: res.missing, loaded: p.total } : p));
      videoEl.src = url;
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [needsFile, timeline, fetcher, videoEl]);

  // A finished file: (re)apply its signed link, keeping the position.
  useEffect(() => {
    const el = videoEl;
    if (!el || partMode) return;
    if (!fileUrl) { el.removeAttribute("src"); return; }
    if (el.getAttribute("src") === fileUrl) return;
    const at = el.currentTime;
    const wasPlaying = !el.paused;
    el.src = fileUrl;
    el.load();
    if (at > 0) {
      el.addEventListener("loadedmetadata", () => {
        el.currentTime = at;
        if (wasPlaying) void el.play().catch(() => undefined);
      }, { once: true });
    }
  }, [fileUrl, videoEl, partMode]);

  const hasVideo = partMode || !!fileUrl;
  const visibleDuration = partMode ? Math.max(duration ?? 0, timeline?.durationSec ?? 0) || null : duration;

  const recordDuration = (d: number) => setDuration(d);

  const seekTo = (sec: number) => {
    const el = videoRef.current;
    if (!el || !visibleDuration) return;
    el.currentTime = Math.min(visibleDuration, Math.max(0, sec));
    void el.play().catch(() => undefined);
  };

  const sorted = useMemo(() => sortViolations(violations), [violations]);
  const originMs = partMode ? timeline?.originMs ?? null : null;

  const markers = useMemo(
    () =>
      sorted
        .map((v) => {
          const at = Date.parse(v.created_at);
          const t = originMs != null && Number.isFinite(at) ? (at - originMs) / 1000 : (v.offset_seconds ?? 0);
          return {
            v,
            seconds: Math.max(0, t),
            label: v.description || v.violation_type,
            severity: v.severity,
            created: v.created_at,
          };
        })
        .sort((a, b) => a.seconds - b.seconds),
    [sorted, originMs],
  );

  // Download the joined pieces as one local file. Never uploaded back: the
  // pieces are the single stored copy of the recording.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMissing, setSaveMissing] = useState<MissingPiece[]>([]);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const saveMergedVideo = async () => {
    if (!timeline || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveMissing([]);
    setMergeMsg(null);
    try {
      const base = `${roll}_${activeSource}_recording`;
      let part = 1;
      let sink = createBlobSink("video/webm");
      const finishFile = async () => {
        const blob = await sink.close();
        if (blob && blob.size > 0) triggerDownload(blob, part === 1 ? `${base}.webm` : `${base}_part${part}.webm`);
      };
      const res = await joinPieces({
        timeline,
        fetcher: createPieceFetcher({ keys: timeline.pieces.map((p) => p.key) }),
        write: sink.write,
        nextFile: async () => {
          await finishFile();
          part += 1;
          sink = createBlobSink("video/webm");
        },
        onProgress: (done, total) => setMergeMsg(`Preparing full video… ${Math.round((done / total) * 100)}%`),
      });
      if (res.bytes === 0) throw new Error("no piece of this recording could be downloaded");
      await finishFile();
      setSaveMissing(res.missing);
      setMergeMsg(null);
    } catch (err) {
      setMergeMsg(null);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const openReport = async () => {
    if (!artifacts.reportKey) return;
    const url = await getArtifactObjectUrl(artifacts.reportKey, LINK_TTL_SEC);
    if (url) window.open(url, "_blank", "noreferrer");
  };

  const playerError = player?.error ?? null;
  const buffering = partMode && hasVideo && !loadError && !playerError && (player?.loaded ?? 0) === 0 && !joinedUrl;
  const missing = player?.missing ?? [];

  return (
    <div className="space-y-4">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden border border-line bg-[#1F231D]">
        {artifacts.status === "loading" && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-paper/60">Loading recording…</p>
        )}
        {partMode && (
          <span className="absolute left-3 top-3 z-10 border border-amber/40 bg-ink/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber">
            Full exam recording · {activeSource === "screen" ? "Screen" : "Camera"}
          </span>
        )}
        {artifacts.status === "ready" && hasVideo && (
          <video
            ref={attachVideo}
            poster={artifacts.posterUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              const d = el.duration;
              if (Number.isFinite(d) && d > 0) {
                recordDuration(d);
              } else if (!partMode) {
                // MediaRecorder .webm files often ship without a duration
                // header (duration = NaN/Infinity). Probe once: seek to a huge
                // time — the browser clamps to the real end and fires
                // durationchange with a finite value, giving us the total for
                // the seek bar + violation markers.
                let probed = false;
                const onDur = () => {
                  if (probed || !Number.isFinite(el.duration) || el.duration <= 0) return;
                  probed = true;
                  el.removeEventListener("durationchange", onDur);
                  recordDuration(el.duration);
                  // The probe seek landed at the end — rewind to the start.
                  el.currentTime = 0;
                };
                el.addEventListener("durationchange", onDur);
                try { el.currentTime = Number.MAX_SAFE_INTEGER; } catch { /* ignore */ }
              }
              setLoadError(false);
            }}
            onDurationChange={(e) => {
              const d = e.currentTarget.duration;
              if (partMode && Number.isFinite(d) && d > 0) recordDuration(d);
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              setCurrent((prev) => (Math.abs(prev - t) > 0.25 ? t : prev));
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={(e) => {
              if (attempt < 2) {
                resumeAt.current = e.currentTarget.currentTime || resumeAt.current;
                setAttempt((a) => a + 1);
              } else {
                setLoadError(true);
              }
            }}
          />
        )}
        {buffering && (
          <span className="absolute bottom-14 left-3 z-10 bg-ink/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-paper/80">
            {needsFile ? "Preparing full video…" : "Loading video…"}
          </span>
        )}
        {artifacts.status === "ready" && !hasVideo && (
          <p className="px-6 text-center font-mono text-[10px] uppercase tracking-widest text-paper/60">Loading recording…</p>
        )}
        {artifacts.status === "empty" && (
          <div className="flex flex-col items-center px-6 text-center">
            {artifacts.posterUrl ? (
              <img src={artifacts.posterUrl} alt="" className="max-h-48 object-contain opacity-80" />
            ) : (
              <span className="font-serif text-3xl text-paper/20">{name.split(" ").map((x) => x[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}</span>
            )}
            <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-paper/50">
              No artifacts stored for {roll}
            </p>
          </div>
        )}
        {artifacts.status === "error" && (
          <p className="px-6 text-center font-mono text-[10px] uppercase tracking-widest text-alert">
            Could not read the recording from secure storage.
          </p>
        )}
        {(loadError || playerError) && hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/85 px-6 text-center">
            <p className="font-mono text-[10px] uppercase tracking-widest text-alert">
              {partMode
                ? `The full video could not be played here${playerError ? ` (${playerError})` : ""}. Use Download full video below to watch it.`
                : "Recording could not be played — it may still be uploading."}
            </p>
          </div>
        )}

        <span className="absolute right-2 top-2 bg-ink/75 px-2 py-1 font-mono text-[9px] uppercase text-paper">
          {hasVideo ? `REC · ${clock(current)}${visibleDuration ? ` / ${clock(visibleDuration)}` : ""}` : "NO RECORDING"}
        </span>
        {playing && <span className="absolute left-2 top-2 h-2 w-2 animate-pulse rounded-none bg-alert" />}
      </div>

      {partMode && <MissingList missing={missing} label={activeSource === "screen" ? "screen recording" : "camera recording"} />}

      {/* Seek bar with RED violation markers */}
      <div className="space-y-2">
        <div
          className="relative h-2 w-full cursor-pointer bg-ink/15"
          onClick={(e) => {
            const total = visibleDuration;
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
          {markers.map((m) => {
            const d = visibleDuration;
            const pct = d && d > 0 ? Math.min(99.5, Math.max(0, (m.seconds / d) * 100)) : null;
            // If we can't calculate position, distribute markers evenly across the bar
            const leftPos = pct !== null ? `${pct}%` : `${Math.min(99.5, (markers.indexOf(m) / Math.max(1, markers.length - 1)) * 100)}%`;
            return (
            <button
              key={m.v.id}
              title={`${m.label} @ ${clock(m.seconds)}`}
              onClick={(e) => { e.stopPropagation(); seekTo(m.seconds); }}
              className={`absolute top-0 h-full w-1.5 -translate-x-1/2 ${m.severity === "critical" || m.severity === "high" ? "bg-alert" : "bg-amber"}`}
              style={{ left: leftPos }}
            />
            );
          })}
        </div>
        <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-ink-soft">
          <span>{markers.length > 0 ? `${markers.length} violation marker(s) in red` : "No violations on this timeline"}</span>
          <span>{clock(current)} {visibleDuration ? `/ ${clock(visibleDuration)}` : ""}</span>
        </div>
      </div>

      {partMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-line px-4 py-3">
          {hasBothSources ? (
            <div className="flex gap-1" role="group" aria-label="Recording source">
              {(["camera", "screen"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  aria-pressed={activeSource === s}
                  className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${activeSource === s ? "border-ink bg-ink text-paper" : "border-line text-ink-soft hover:border-ink"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : (
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              {activeSource === "screen" ? "Full screen recording" : "Full camera recording"}
            </p>
          )}
          <button
            onClick={() => void saveMergedVideo()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 border border-ink px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiDownload aria-hidden />
            {saving ? "Preparing…" : "Download full video"}
          </button>
        </div>
      )}
      {mergeMsg && (
        <p className="font-mono text-[10px] text-ink-soft">{mergeMsg}</p>
      )}
      {saveError && (
        <p className="font-mono text-[10px] text-alert">Could not download full video — {saveError}.</p>
      )}
      {saveMissing.length > 0 && <MissingList missing={saveMissing} label="downloaded video" />}

      {/* Violation log with jump buttons */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Violation log</p>
        <div className="mt-2 space-y-2">
          {markers.length === 0 && (
            <p className="border-l-2 border-success bg-success/5 px-3 py-2 text-[12px] text-ink-soft">
              No proctoring flags recorded for this candidate.
            </p>
          )}
          {markers.map((m, i) => {
            const isAudio = /voice|speak|audio|talk|sound/i.test(m.label);
            const sevColor =
              m.severity === "critical" || m.severity === "high" ? "text-alert border-alert"
              : m.severity === "warning" ? "text-amber border-amber"
              : "text-ink-soft border-line";
            return (
            <div key={m.v.id} className={`flex items-center justify-between gap-3 border-l-2 ${m.severity === "critical" || m.severity === "high" ? "border-alert" : m.severity === "warning" ? "border-amber" : "border-forest"} bg-alert/[0.04] p-3`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium">{m.label}</p>
                  <span className={`border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider ${sevColor}`}>
                    {m.severity ?? "low"}
                  </span>
                  {isAudio && (
                    <span className="border border-amber/40 bg-amber/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-amber">
                      🔊 Audio
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-ink-soft">
                  #{i + 1} · {m.v.violation_type} · {new Date(m.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
            );
          })}
        </div>
      </div>

      {/* Per-second screenshot timeline — scrollable strip of camera
          snapshots taken every 1 second during the exam. Teachers can
          visually scan what the student looked like at any moment. */}
      {artifacts.screenshotTimelineUrls.length > 0 && (
        <div>
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Screenshot timeline · {artifacts.screenshotTimelineUrls.length} frame{artifacts.screenshotTimelineUrls.length === 1 ? "" : "s"}</p>
            <p className="font-mono text-[9px] text-ink-soft">1 frame / second</p>
          </div>
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-2" style={{ scrollbarWidth: "thin" }}>
            {artifacts.screenshotTimelineUrls.map((snap, i) => {
              // Place the frame on the recording's timeline by wall-clock time
              // (or relative to the first frame for older recordings).
              const firstTs = originMs ?? artifacts.screenshotTimelineUrls[0]?.timestamp ?? snap.timestamp;
              const offsetSec = Math.max(0, Math.round((snap.timestamp - firstTs) / 1000));
              
              // Find if any violation occurred near this snapshot (+/- 1.5 seconds)
              const nearbyViolations = markers.filter(m => Math.abs(m.seconds - offsetSec) <= 1.5);
              const hasCritical = nearbyViolations.some(m => m.severity === "critical" || m.severity === "high");
              const hasWarning = nearbyViolations.length > 0;
              const hasAudio = nearbyViolations.some(m => /voice|speak|audio|talk|sound/i.test(m.label));
              
              const borderClass = hasCritical ? "border-alert" : hasWarning ? "border-amber" : "border-line group-hover:border-forest";

              return (
                <button
                  key={snap.url}
                  title={`${clock(offsetSec)} into exam${hasWarning ? ' (Warning)' : ''}`}
                  onClick={() => seekTo(offsetSec)}
                  className={`group relative flex-shrink-0 border-2 transition-colors ${borderClass}`}
                >
                  <img
                    src={snap.url}
                    alt={`frame ${i + 1}`}
                    loading="lazy"
                    className={`h-14 w-20 object-cover ${hasWarning ? "opacity-90" : ""}`}
                  />
                  <span className={`absolute bottom-0 left-0 right-0 px-1 py-0.5 text-center font-mono text-[8px] text-paper ${hasCritical ? "bg-alert/80" : hasWarning ? "bg-amber/80" : "bg-ink/60"}`}>
                    {clock(offsetSec)}
                  </span>
                  {hasAudio && (
                    <span className="absolute top-0 right-0 bg-amber px-1 py-0.5 text-[8px]">🔊</span>
                  )}
                  {hasWarning && !hasAudio && (
                    <span className="absolute top-0 right-0 bg-alert px-1 py-0.5 text-[8px] text-paper">⚠️</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Violation snapshots + report */}
      {(artifacts.snapshotUrls.length > 0 || artifacts.reportKey) && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Evidence</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {artifacts.snapshotUrls.slice(0, 6).map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="border border-line bg-paper-raised p-0.5 hover:border-alert">
                <img src={u} alt={`flagged frame ${i + 1}`} className="h-16 w-24 object-cover" />
              </a>
            ))}
            {artifacts.reportKey && (
              <button
                onClick={() => void openReport()}
                className="border border-forest bg-forest/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-forest/10"
              >
                <FiDownload aria-hidden /> Open PDF report
              </button>
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
