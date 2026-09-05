import { useCallback, useEffect, useRef, useState } from "react";

// ── Interactive Image Cropper ─────────────────────────────────────────────────
// Renders the image on a canvas and lets the user drag a crop rectangle.
// On confirm → returns the cropped Blob via onCrop().

type CropRect = { x: number; y: number; w: number; h: number };

type ImageCropperProps = {
  blob: Blob;
  onCrop: (cropped: Blob) => void;
  onCancel: () => void;
};

export default function ImageCropper({ blob, onCrop, onCancel }: ImageCropperProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<CropRect>({ x: 20, y: 20, w: 0, h: 0 });
  const [dragging, setDragging] = useState<"none" | "move" | "resize">("none");
  const dragStart = useRef({ mx: 0, my: 0, cx: 0, cy: 0, cw: 0, ch: 0 });
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [scale, setScale] = useState(1);
  const [loaded, setLoaded] = useState(false);
  // Issue #8: track context availability so we can show a friendly fallback
  const [ctxError, setCtxError] = useState(false);

  // ── Issue #5: RAF-based rendering ─────────────────────────────────────────
  // Instead of calling draw() inside setCrop (which causes a re-render → draw
  // cascade at 100+ fps), we store the latest crop in a ref and schedule a
  // single rAF-throttled draw. This caps GPU work at 60fps and eliminates
  // wasteful re-renders during mouse drags.
  const cropRef = useRef(crop);
  cropRef.current = crop; // keep ref in sync for the rAF draw loop
  const rafIdRef = useRef<number>(0);

  // Load image
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setLoaded(true);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setCtxError(true);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  // Draw — reads from cropRef so it never triggers re-renders
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;

    // ── Issue #8: null-safe context access ────────────────────────────────
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.error("[ImageCropper] canvas 2D context unavailable — GPU memory may be exhausted");
      setCtxError(true);
      return;
    }

    const c = cropRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Dark overlay outside crop
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, canvas.width, c.y);
    ctx.fillRect(0, c.y + c.h, canvas.width, canvas.height - c.y - c.h);
    ctx.fillRect(0, c.y, c.x, c.h);
    ctx.fillRect(c.x + c.w, c.y, canvas.width - c.x - c.w, c.h);

    // Crop border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x, c.y, c.w, c.h);

    // Rule of thirds grid
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(c.x + (c.w * i) / 3, c.y);
      ctx.lineTo(c.x + (c.w * i) / 3, c.y + c.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c.x, c.y + (c.h * i) / 3);
      ctx.lineTo(c.x + c.w, c.y + (c.h * i) / 3);
      ctx.stroke();
    }

    // Corner handles
    const hs = 10;
    ctx.fillStyle = "#ffffff";
    [[c.x, c.y], [c.x + c.w - hs, c.y], [c.x, c.y + c.h - hs], [c.x + c.w - hs, c.y + c.h - hs]].forEach(([hx, hy]) => {
      ctx.fillRect(hx!, hy!, hs, hs);
    });
  }, []); // [ok] no `crop` dep — reads cropRef.current instead

  // Init crop size after image loads
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !loaded) return;
    const maxW = Math.min(600, window.innerWidth - 32);
    const ratio = img.naturalHeight / img.naturalWidth;
    canvas.width = maxW;
    canvas.height = maxW * ratio;
    const s = maxW / img.naturalWidth;
    setScale(s);
    const margin = 20;
    setCrop({ x: margin, y: margin, w: canvas.width - margin * 2, h: canvas.height - margin * 2 });
  }, [loaded]);

  // Draw whenever crop changes — but via rAF to cap at 60fps
  useEffect(() => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, [draw, crop]); // ← crop dep triggers the rAF schedule; draw() itself reads cropRef

  // Mouse / touch events
  const getPos = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    // ── Issue #8: null-safe canvas ref ────────────────────────────────────
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    if ("touches" in e) {
      const t = e.touches[0];
      if (!t) return { x: 0, y: 0 };
      return { x: (t.clientX - rect.left) * sx, y: (t.clientY - rect.top) * sy };
    }
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    const { x, y } = getPos(e);
    const hs = 20;
    const atCorner = x > crop.x + crop.w - hs && y > crop.y + crop.h - hs;
    const inside = x > crop.x && x < crop.x + crop.w && y > crop.y && y < crop.y + crop.h;
    dragStart.current = { mx: x, my: y, cx: crop.x, cy: crop.y, cw: crop.w, ch: crop.h };
    setDragging(atCorner ? "resize" : inside ? "move" : "none");
  };

  // ── Issue #5: rAF-throttled onMove ────────────────────────────────────────
  // We update cropRef directly and schedule a rAF redraw instead of calling
  // setCrop on every mouse event. State (and thus re-renders) only updates
  // on pointerUp so React's reconciler isn't hammered 100x/second.
  const pendingCropRef = useRef<CropRect | null>(null);

  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (dragging === "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = getPos(e);
    const dx = x - dragStart.current.mx;
    const dy = y - dragStart.current.my;

    let next: CropRect;
    if (dragging === "move") {
      next = {
        ...cropRef.current,
        x: Math.max(0, Math.min(canvas.width - cropRef.current.w, dragStart.current.cx + dx)),
        y: Math.max(0, Math.min(canvas.height - cropRef.current.h, dragStart.current.cy + dy)),
      };
    } else {
      next = {
        ...cropRef.current,
        w: Math.max(40, Math.min(canvas.width - cropRef.current.x, dragStart.current.cw + dx)),
        h: Math.max(40, Math.min(canvas.height - cropRef.current.y, dragStart.current.ch + dy)),
      };
    }

    // Write directly to ref + redraw via rAF — no re-render on every pixel
    cropRef.current = next;
    pendingCropRef.current = next;
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(draw);
  };

  // Commit the pending crop to React state only on pointer up (one re-render per drag)
  const onUp = () => {
    setDragging("none");
    if (pendingCropRef.current) {
      setCrop(pendingCropRef.current);
      pendingCropRef.current = null;
    }
  };

  const confirmCrop = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const out = document.createElement("canvas");
    const naturalScale = 1 / scale;
    out.width = Math.round(crop.w * naturalScale);
    out.height = Math.round(crop.h * naturalScale);

    // ── Issue #8: null-safe context in confirmCrop ─────────────────────────
    const ctx = out.getContext("2d");
    if (!ctx) {
      console.error("[ImageCropper] confirmCrop: canvas context unavailable");
      setCtxError(true);
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(img, crop.x * naturalScale, crop.y * naturalScale, out.width, out.height, 0, 0, out.width, out.height);
    out.toBlob((b) => { if (b) onCrop(b); }, "image/jpeg", 0.9);
  };

  // ── Issue #8: friendly error fallback when canvas is unavailable ──────────
  if (ctxError) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink text-paper gap-4 p-6">
        <p className="font-serif text-xl">Canvas unavailable</p>
        <p className="text-center text-[13px] text-paper/60 max-w-sm">
          Your browser cannot render the image editor right now (possibly due to memory pressure or
          an accessibility restriction). Please upload the image directly without cropping.
        </p>
        <button
          onClick={onCancel}
          className="border border-white/20 px-4 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-white/10"
        >
          ← Go back
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink text-paper">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <button onClick={onCancel} className="font-mono text-[10px] uppercase tracking-wider text-paper/60 hover:text-paper">← Cancel</button>
        <p className="font-mono text-[11px] uppercase tracking-widest">Crop image</p>
        <button onClick={confirmCrop} className="font-mono text-[10px] uppercase tracking-wider text-success hover:text-success/80">Confirm →</button>
      </div>

      <div className="flex-1 overflow-auto flex items-center justify-center p-2">
        <canvas
          ref={canvasRef}
          className="max-w-full touch-none cursor-crosshair"
          style={{ display: loaded ? undefined : "none" }}
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
        />
        {!loaded && <p className="font-mono text-[11px] text-paper/50">Loading…</p>}
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-white/10 px-4 py-3">
        <p className="font-mono text-[9px] uppercase tracking-wider text-paper/50">Drag to move · corner to resize</p>
      </div>
    </div>
  );
}
