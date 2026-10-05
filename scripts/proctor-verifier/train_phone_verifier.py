"""Train the second-stage phone verifier from labelled exam snapshots.

Usage (Python 3.11, `pip install pymupdf "mediapipe==0.10.14" pillow numpy`):

  python train_phone_verifier.py --pdf Session_Report.pdf --phone "6,9,13-21,28-35"
  python train_phone_verifier.py --pdf a.pdf --phone "..." --pdf b.pdf --phone "..."

Each --pdf is a Session Report exported from the teacher console; --phone
lists the 1-based snapshot numbers (in PDF order) where a phone is visible,
even partly. Every other snapshot is treated as clean. Prints held-out
results and the constants to paste into
src/features/proctoring/domain/phoneVerifier.ts.

Snapshots are faces of real students: keep them out of git.
"""
import argparse, hashlib, io, json, math
from pathlib import Path

import mediapipe as mp
import numpy as np
import pymupdf
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision
from PIL import Image

MODELS = Path(__file__).resolve().parents[2] / "public" / "ai" / "models"
PHONE_LABELS = {"cell phone", "remote"}
# Same crops the app runs: full frame, desk, left and right edges.
REGIONS = {"full": (0, 0, 1, 1), "desk": (0, 0.4, 1, 0.6), "left": (0, 0.15, 0.4, 0.85), "right": (0.6, 0.15, 0.4, 0.85)}
NAMES = ["score", "cy", "log_area", "log_aspect", "facezone", "rel_y", "rel_size", "lum", "sat", "bottom", "no_face"]


def frames_from_pdf(path):
    doc = pymupdf.open(path)
    seen, out = set(), []
    for page in doc:
        for img in page.get_images(full=True):
            if img[0] in seen:
                continue
            seen.add(img[0])
            d = doc.extract_image(img[0])
            h = hashlib.md5(d["image"]).hexdigest()
            if d["width"] < 200 or h in seen:
                continue
            seen.add(h)
            out.append(Image.open(io.BytesIO(d["image"])).convert("RGB"))
    return out


def parse_ranges(spec):
    out = set()
    for part in filter(None, spec.split(",")):
        a, _, b = part.strip().partition("-")
        out.update(range(int(a), int(b or a) + 1))
    return out


def features(score, box, face, lum, sat):
    x, y, w, h = box
    cy = y + h / 2
    facezone, rel_y, rel_size, no_face = 0.0, 2.0, 1.0, 1.0
    if face:
        fx, fy, fw, fh = face
        zx0, zx1, zy0, zy1 = fx - fw * 0.3, fx + fw * 1.3, fy, fy + fh * 1.6
        ix = max(0, min(x + w, zx1) - max(x, zx0))
        iy = max(0, min(y + h, zy1) - max(y, zy0))
        facezone = ix * iy / max(w * h, 1e-6)
        rel_y = max(-2, min(4, (cy - (fy + fh / 2)) / max(fh, 1e-6)))
        rel_size = min(4, (w * h) / max(fw * fh, 1e-6))
        no_face = 0.0
    return [score, cy, math.log(max(w * h, 1e-4)), math.log(max(w / max(h, 1e-6), 1e-3)),
            facezone, rel_y, rel_size, lum, sat, y + h, no_face]


def collect(frames, phone_ids, det, face_det, offset):
    rows = []
    for n, im in enumerate(frames, start=1):
        arr = np.asarray(im)
        H, W = arr.shape[:2]
        fr = face_det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=arr))
        face = None
        if fr.detections:
            b = fr.detections[0].bounding_box
            face = (b.origin_x / W, b.origin_y / H, b.width / W, b.height / H)
        for x, y, w, h in REGIONS.values():
            x0, y0 = int(x * W), int(y * H)
            crop = arr[y0:int((y + h) * H), x0:int((x + w) * W)].copy()
            for d in det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)).detections:
                c = d.categories[0]
                if c.category_name not in PHONE_LABELS:
                    continue
                bb = d.bounding_box
                box = ((bb.origin_x + x0) / W, (bb.origin_y + y0) / H, bb.width / W, bb.height / H)
                px = arr[int(box[1] * H):int((box[1] + box[3]) * H), int(box[0] * W):int((box[0] + box[2]) * W)]
                px = px.reshape(-1, 3).astype(float) if px.size else np.zeros((1, 3))
                rows.append((offset + n, n in phone_ids,
                             features(c.score, box, face, px.mean() / 255, (px.max(1) - px.min(1)).mean() / 255)))
    return rows


def fit(X, y, mu, sd, l2=0.05, iters=4000, lr=0.3):
    Z = (X - mu) / sd
    w, b0 = np.zeros(Z.shape[1]), 0.0
    sw = np.where(y == 1, (1 - y.mean()) / y.mean(), 1.0)
    for _ in range(iters):
        g = (1 / (1 + np.exp(-(Z @ w + b0))) - y) * sw
        w -= lr * (Z.T @ g / len(y) + l2 * w)
        b0 -= lr * g.mean()
    return w, b0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", action="append", required=True)
    ap.add_argument("--phone", action="append", required=True)
    ap.add_argument("--min", type=float, default=0.7)
    a = ap.parse_args()
    assert len(a.pdf) == len(a.phone), "one --phone list per --pdf"

    det = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=mpt.BaseOptions(model_asset_path=str(MODELS / "efficientdet_lite0.tflite")),
        score_threshold=0.08, max_results=15))
    face_det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=mpt.BaseOptions(model_asset_path=str(MODELS / "blaze_face_short_range.tflite"))))

    rows, phone_frames, all_frames, offset = [], set(), [], 0
    for pdf, spec in zip(a.pdf, a.phone):
        frames = frames_from_pdf(pdf)
        ids = parse_ranges(spec)
        rows += collect(frames, ids, det, face_det, offset)
        phone_frames |= {offset + i for i in ids}
        all_frames += [offset + i for i in range(1, len(frames) + 1)]
        offset += len(frames)

    frame = np.array([r[0] for r in rows])
    y = np.array([1.0 if r[1] else 0.0 for r in rows])
    X = np.array([r[2] for r in rows])
    mu, sd = X.mean(0), X.std(0) + 1e-6

    # Time-blocked folds: neighbouring seconds never straddle train/test.
    folds = np.minimum((frame - 1) * 5 // max(offset, 1), 4)
    oof = np.zeros(len(y))
    for k in range(5):
        w, b0 = fit(X[folds != k], y[folds != k], mu, sd)
        oof[folds == k] = 1 / (1 + np.exp(-(((X[folds == k] - mu) / sd) @ w + b0)))

    def frame_hits(scores, thr):
        return {f for f in set(frame) if (scores[frame == f] >= thr).any()}
    P, N = len(phone_frames), len(all_frames) - len(phone_frames)
    for name, scores, thr in [("raw score >= 0.10", X[:, 0], 0.10), (f"verifier >= {a.min}", oof, a.min)]:
        hit = frame_hits(scores, thr)
        print(f"{name:20s} phone frames caught {len(hit & phone_frames)}/{P}, false alarms {len(hit - phone_frames)}/{N}")

    w, b0 = fit(X, y, mu, sd)
    print(json.dumps({"names": NAMES, "mean": mu.round(5).tolist(), "std": sd.round(5).tolist(),
                      "weights": w.round(4).tolist(), "bias": round(float(b0), 4)}))


if __name__ == "__main__":
    main()
