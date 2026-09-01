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

  // Load image
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setLoaded(true);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  // Draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Dark overlay outside crop
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, canvas.width, crop.y);
    ctx.fillRect(0, crop.y + crop.h, canvas.width, canvas.height - crop.y - crop.h);
    ctx.fillRect(0, crop.y, crop.x, crop.h);
    ctx.fillRect(crop.x + crop.w, crop.y, canvas.width - crop.x - crop.w, crop.h);

    // Crop border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);

    // Rule of thirds grid
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(crop.x + (crop.w * i) / 3, crop.y);
      ctx.lineTo(crop.x + (crop.w * i) / 3, crop.y + crop.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(crop.x, crop.y + (crop.h * i) / 3);
      ctx.lineTo(crop.x + crop.w, crop.y + (crop.h * i) / 3);
      ctx.stroke();
    }

    // Corner handles
    const hs = 10;
    ctx.fillStyle = "#ffffff";
    [[crop.x, crop.y], [crop.x + crop.w - hs, crop.y], [crop.x, crop.y + crop.h - hs], [crop.x + crop.w - hs, crop.y + crop.h - hs]].forEach(([hx, hy]) => {
      ctx.fillRect(hx, hy, hs, hs);
    });
  }, [crop]);

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

  useEffect(() => { draw(); }, [draw]);

  // Mouse / touch events
  const getPos = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    if ("touches" in e) {
      const t = e.touches[0];
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

  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (dragging === "none") return;
    const canvas = canvasRef.current!;
    const { x, y } = getPos(e);
    const dx = x - dragStart.current.mx;
    const dy = y - dragStart.current.my;
    if (dragging === "move") {
      setCrop((c) => ({
        ...c,
        x: Math.max(0, Math.min(canvas.width - c.w, dragStart.current.cx + dx)),
        y: Math.max(0, Math.min(canvas.height - c.h, dragStart.current.cy + dy)),
      }));
    } else {
      setCrop((c) => ({
        ...c,
        w: Math.max(40, Math.min(canvas.width - c.x, dragStart.current.cw + dx)),
        h: Math.max(40, Math.min(canvas.height - c.y, dragStart.current.ch + dy)),
      }));
    }
  };

  const onUp = () => setDragging("none");

  const confirmCrop = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const out = document.createElement("canvas");
    const naturalScale = 1 / scale;
    out.width = Math.round(crop.w * naturalScale);
    out.height = Math.round(crop.h * naturalScale);
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(img, crop.x * naturalScale, crop.y * naturalScale, out.width, out.height, 0, 0, out.width, out.height);
    out.toBlob((b) => { if (b) onCrop(b); }, "image/jpeg", 0.9);
  };

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
