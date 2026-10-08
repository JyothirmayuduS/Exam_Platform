// Measures recording + snapshot storage for one exam, before and after the
// low-bandwidth change, using Chromium's own JPEG encoder and MediaRecorder.
//
//   node scripts/measure-proctor-storage.mjs [sampleSeconds=60] [examMinutes=120]
//
// Camera: a 640x480 webcam-like scene (photo background, a swaying head and
// shoulders, sensor noise) with a microphone track. Screen: a 1366x768 exam
// page with a ticking clock and a new question every 30 s. Each recorder runs
// for `sampleSeconds` (one at a time), and bytes per second are scaled to the exam length.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const SAMPLE_S = Number(process.argv[2] ?? 60);
const EXAM_S = Number(process.argv[3] ?? 120) * 60;
const PHOTO = "/System/Library/Desktop Pictures/.thumbnails/Calibrate 5120x3200.jpg";

const settings = {
  before: {
    snapshot: { everyS: 1, maxEdge: 640, quality: 0.6 },
    violation: { maxEdge: 1600, quality: 0.85 },
    cameraBps: 1_600_000,
    screenBps: 2_500_000,
  },
  after: {
    snapshot: { everyS: 20, maxEdge: 480, quality: 0.5 },
    violation: { maxEdge: 960, quality: 0.7 },
    cameraBps: 500_000,
    screenBps: 700_000,
  },
};

let photo = "";
try { photo = `data:image/jpeg;base64,${readFileSync(PHOTO).toString("base64")}`; } catch { /* gradient background instead */ }

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");

const result = await page.evaluate(async ({ settings, SAMPLE_S, photo }) => {
  const bg = new Image();
  if (photo) { bg.src = photo; await bg.decode().catch(() => {}); }

  // ── Webcam-like source ───────────────────────────────────────────────────
  const cam = document.createElement("canvas");
  cam.width = 640; cam.height = 480;
  const cx = cam.getContext("2d");
  let t = 0;
  const drawCam = () => {
    t += 1;
    if (bg.complete && bg.naturalWidth) cx.drawImage(bg, 0, 0, 640, 480);
    else { const g = cx.createLinearGradient(0, 0, 640, 480); g.addColorStop(0, "#8a7"); g.addColorStop(1, "#345"); cx.fillStyle = g; cx.fillRect(0, 0, 640, 480); }
    const sway = Math.sin(t / 20) * 12;
    cx.fillStyle = "#3b4a6b"; cx.beginPath(); cx.ellipse(320 + sway, 470, 190, 130, 0, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = "#c99a7a"; cx.beginPath(); cx.ellipse(320 + sway, 240, 85, 110, Math.sin(t / 35) * 0.08, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = "#2a1d15"; cx.beginPath(); cx.ellipse(320 + sway, 160, 90, 45, 0, Math.PI, Math.PI * 2); cx.fill();
    const img = cx.getImageData(0, 0, 640, 480);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 12;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    cx.putImageData(img, 0, 0);
  };

  // ── Exam screen source (text paper) ──────────────────────────────────────
  const scr = document.createElement("canvas");
  scr.width = 1366; scr.height = 768;
  const sx = scr.getContext("2d");
  let sec = 0;
  const drawScreen = () => {
    sx.fillStyle = "#f7f5f0"; sx.fillRect(0, 0, 1366, 768);
    sx.fillStyle = "#1a3a2a"; sx.fillRect(0, 0, 1366, 56);
    sx.fillStyle = "#fff"; sx.font = "600 18px monospace";
    const left = 7200 - sec;
    sx.fillText(`Data Structures Midterm   ${String(Math.floor(left / 3600)).padStart(2, "0")}:${String(Math.floor(left / 60) % 60).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`, 24, 35);
    const q = Math.floor(sec / 30) + 1;
    sx.fillStyle = "#222"; sx.font = "20px serif";
    sx.fillText(`Question ${q} of 60`, 60, 120);
    const words = "Consider a binary search tree built by inserting the keys in the given order. Which traversal visits the keys in ascending order, and what is the height of the resulting tree after the final insertion".split(" ");
    let line = "", y = 160;
    for (const w of words) { if ((line + w).length > 80) { sx.fillText(line, 60, y); line = ""; y += 30; } line += `${w} `; }
    sx.fillText(line, 60, y);
    ["A. Pre-order", "B. In-order", "C. Post-order", "D. Level-order"].forEach((o, i) => {
      sx.strokeStyle = "#999"; sx.strokeRect(60, 260 + i * 60, 600, 44);
      sx.fillText(o, 80, 290 + i * 60);
    });
    for (let i = 0; i < 60; i++) { sx.fillStyle = i < q ? "#284b34" : "#ddd"; sx.fillRect(1000 + (i % 6) * 50, 120 + Math.floor(i / 6) * 50, 40, 40); }
  };

  const camTimer = setInterval(drawCam, 1000 / 15);
  const scrTimer = setInterval(() => { sec += 1; drawScreen(); }, 1000);
  drawCam(); drawScreen();

  // ── Snapshots: real JPEG bytes at each setting ───────────────────────────
  const jpegBytes = (source, maxEdge, quality) => {
    const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
    const c = document.createElement("canvas");
    c.width = Math.round(source.width * scale); c.height = Math.round(source.height * scale);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", quality);
    return Math.round((url.length - url.indexOf(",") - 1) * 3 / 4);
  };
  const snap = {};
  for (const [name, s] of Object.entries(settings)) {
    let periodic = 0, violation = 0;
    const N = 40;
    for (let i = 0; i < N; i++) {
      drawCam();
      periodic += jpegBytes(cam, s.snapshot.maxEdge, s.snapshot.quality);
      violation += jpegBytes(cam, s.violation.maxEdge, s.violation.quality);
    }
    snap[name] = { periodicBytes: periodic / N, violationBytes: violation / N };
  }

  // ── Recordings: MediaRecorder bytes per second ───────────────────────────
  const audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain(); gain.gain.value = 0.05;
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(gain).connect(dest); osc.start();
  const mic = dest.stream.getAudioTracks()[0];
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));

  const record = (stream, bps) => new Promise((resolve) => {
    let bytes = 0;
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps });
    mr.ondataavailable = (e) => { bytes += e.data.size; };
    mr.onstop = () => resolve(bytes / SAMPLE_S);
    mr.start(10_000);
    setTimeout(() => mr.stop(), SAMPLE_S * 1000);
  });
  const camStream = () => new MediaStream([cam.captureStream(15).getVideoTracks()[0], mic.clone()]);
  const scrStream = () => scr.captureStream(15);
  // One recorder at a time so encoders don't compete for CPU and drop frames.
  const camBefore = await record(camStream(), settings.before.cameraBps);
  const camAfter = await record(camStream(), settings.after.cameraBps);
  const scrBefore = await record(scrStream(), settings.before.screenBps);
  const scrAfter = await record(scrStream(), settings.after.screenBps);
  clearInterval(camTimer); clearInterval(scrTimer);
  return { mime, snap, rec: { before: { camera: camBefore, screen: scrBefore }, after: { camera: camAfter, screen: scrAfter } } };
}, { settings, SAMPLE_S, photo });

await browser.close();

const MB = (b) => b / 1e6;
const fmt = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${MB(b).toFixed(1)} MB`);
console.log(`Encoder: ${result.mime} · sample ${SAMPLE_S} s per recorder · exam ${EXAM_S / 60} min\n`);
const totals = {};
for (const name of ["before", "after"]) {
  const s = settings[name];
  const r = result.rec[name];
  const snaps = Math.floor(EXAM_S / s.snapshot.everyS) + 1;
  // Each recording is stored twice: live parts during the exam + the merged file at submit.
  const camera = r.camera * EXAM_S * 2;
  const screen = r.screen * EXAM_S * 2;
  const snapshots = snaps * result.snap[name].periodicBytes;
  const total = camera + screen + snapshots;
  totals[name] = total;
  console.log(`${name.toUpperCase()}`);
  console.log(`  camera recording  ${(r.camera * 8 / 1000).toFixed(0)} kbps measured  → ${fmt(camera)} (parts + merged file)`);
  console.log(`  screen recording  ${(r.screen * 8 / 1000).toFixed(0)} kbps measured  → ${fmt(screen)} (parts + final file)`);
  console.log(`  snapshots         ${snaps} × ${(result.snap[name].periodicBytes / 1000).toFixed(1)} KB → ${fmt(snapshots)}`);
  console.log(`  violation frame   ${(result.snap[name].violationBytes / 1000).toFixed(1)} KB each`);
  console.log(`  TOTAL             ${fmt(total)}\n`);
}
console.log(`Saved per exam: ${fmt(totals.before - totals.after)} (${Math.round((1 - totals.after / totals.before) * 100)}% less)`);
