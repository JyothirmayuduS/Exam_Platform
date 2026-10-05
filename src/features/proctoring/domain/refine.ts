// ────────────────────────────────────────────────────────────────────────────
// Detection refinement using the student's own face geometry.
//
// EfficientDet (COCO) has no earbud class. In field reports it labelled black
// earbuds and fingers resting on the chin as "cell phone" at 24–33 %, while
// real phones at the frame edge were missed. Face landmarks tell us where the
// ears and the face are, so:
//   • a small "phone" box beside an ear is an EARBUD,
//   • a small "phone" box on the face is a finger/chin false positive,
//   • a "laptop" box touching the bottom edge is a phone held low.
// Pure math — no DOM.
// ────────────────────────────────────────────────────────────────────────────

import type { BBox, Detection } from "@/features/proctoring/domain/types";

type Pt = { x: number; y: number };

export interface FaceGeometry {
  /** Tight box around all face landmarks (normalized). */
  face: BBox;
  /** Square search zones around each ear (normalized, clamped to frame). */
  ears: BBox[];
  at: number;
}

/** Landmarks at the outer face edge level with the ear (MediaPipe face mesh). */
const EAR_LANDMARKS = [234, 454] as const;

function clampBox(b: BBox): BBox {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, width: Math.max(0, Math.min(1, b.x + b.width) - x), height: Math.max(0, Math.min(1, b.y + b.height) - y) };
}

export function faceGeometryFromLandmarks(lms: ReadonlyArray<Pt>, at: number): FaceGeometry | null {
  if (!lms.length) return null;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lms) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const fw = maxX - minX;
  const fh = maxY - minY;
  if (fw <= 0.02 || fh <= 0.02) return null;
  const cx = (minX + maxX) / 2;
  const size = Math.max(fw, fh) * 0.42;
  const ears: BBox[] = [];
  for (const idx of EAR_LANDMARKS) {
    const p = lms[idx];
    if (!p) continue;
    // Push the zone outward from the face centre: the ear sits just past the
    // cheek-edge landmark, slightly below eye level.
    const out = p.x < cx ? -1 : 1;
    const ex = p.x + out * size * 0.25;
    const ey = p.y + size * 0.1;
    ears.push(clampBox({ x: ex - size / 2, y: ey - size / 2, width: size, height: size }));
  }
  return { face: { x: minX, y: minY, width: fw, height: fh }, ears, at };
}

function centre(b: BBox): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function contains(b: BBox, p: Pt, slack = 0): boolean {
  return p.x >= b.x - slack && p.x <= b.x + b.width + slack && p.y >= b.y - slack && p.y <= b.y + b.height + slack;
}

function shrink(b: BBox, f: number): BBox {
  const dx = (b.width * f) / 2;
  const dy = (b.height * f) / 2;
  return { x: b.x + dx, y: b.y + dy, width: b.width - dx * 2, height: b.height - dy * 2 };
}

const area = (b: BBox) => b.width * b.height;

export const REFINE = {
  /** A "phone" smaller than this beside an ear is treated as an earbud. */
  EARBUD_MAX_AREA: 0.02,
  /** A "phone" smaller than this centred on the face is a finger/chin artefact. */
  FACE_ARTEFACT_MAX_AREA: 0.025,
  /** Face geometry older than this is ignored (head moved / left frame). */
  FACE_MAX_AGE_MS: 700,
  /** "Laptop" boxes touching the bottom edge and smaller than this are phones held low. */
  LOW_PHONE_MAX_AREA: 0.25,
} as const;

/** Reclassify / drop raw detections using where the face and ears are. */
export function refineDetections(dets: Detection[], face: FaceGeometry | null, now: number): Detection[] {
  const fresh = face && now - face.at <= REFINE.FACE_MAX_AGE_MS ? face : null;
  const out: Detection[] = [];
  for (const d of dets) {
    const a = area(d.bbox);
    const c = centre(d.bbox);
    if (d.kind === "laptop" && d.bbox.y + d.bbox.height >= 0.93 && a <= REFINE.LOW_PHONE_MAX_AREA) {
      out.push({ ...d, kind: "phone", label: `${d.label} (phone held low)` });
      continue;
    }
    if (d.kind === "phone" && fresh) {
      if (a <= REFINE.EARBUD_MAX_AREA && fresh.ears.some((e) => contains(e, c, 0.01))) {
        out.push({ ...d, kind: "earbuds", label: `${d.label} (at ear)` });
        continue;
      }
      if (a <= REFINE.FACE_ARTEFACT_MAX_AREA && contains(shrink(fresh.face, 0.15), c)) {
        continue;
      }
    }
    out.push(d);
  }
  return out;
}
