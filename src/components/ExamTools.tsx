import { useRef, useState } from "react";

// On-screen exam tools: a working calculator and a free-draw rough sheet.
// The trigger buttons render inline (placed by the exam page in its right rail);
// the panels float bottom-right so they never overlap the question navigator.

type Tool = "calc" | "sheet" | null;

export default function ExamTools() {
  const [open, setOpen] = useState<Tool>(null);
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <ToolButton active={open === "calc"} label="Calculator" onClick={() => setOpen((t) => (t === "calc" ? null : "calc"))} />
        <ToolButton active={open === "sheet"} label="Rough sheet" onClick={() => setOpen((t) => (t === "sheet" ? null : "sheet"))} />
      </div>
      {open === "calc" && <Calculator onClose={() => setOpen(null)} />}
      {open === "sheet" && <ScratchPad onClose={() => setOpen(null)} />}
    </>
  );
}

function ToolButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`border px-2 py-2 font-mono text-[9px] uppercase tracking-wider transition-colors ${active ? "border-maroon bg-maroon text-paper" : "border-line-strong bg-paper text-ink-soft hover:text-ink"}`}
    >
      {label}
    </button>
  );
}

// ── Calculator ────────────────────────────────────────────────────────────────
function Calculator({ onClose }: { onClose: () => void }) {
  const [expr, setExpr] = useState("");
  const [result, setResult] = useState("");

  const append = (t: string) => { setExpr((e) => e + t); setResult(""); };
  const clearAll = () => { setExpr(""); setResult(""); };
  const back = () => setExpr((e) => e.slice(0, -1));

  const evaluate = () => {
    try {
      const value = safeEval(expr);
      if (value === null || !Number.isFinite(value)) { setResult("Error"); return; }
      setResult(String(Number(value.toFixed(10))));
    } catch {
      setResult("Error");
    }
  };

  const keys = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "%", "+"];
  return (
    <Panel title="Calculator" onClose={onClose} className="w-64">
      <div className="border border-line-strong bg-paper px-3 py-2 text-right">
        <div className="min-h-[16px] font-mono text-[11px] text-ink-soft break-all">{expr || "0"}</div>
        <div className="min-h-[22px] font-mono text-[18px] text-ink break-all">{result}</div>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <CalcKey label="C" onClick={clearAll} tone="alert" />
        <CalcKey label="(" onClick={() => append("(")} />
        <CalcKey label=")" onClick={() => append(")")} />
        <CalcKey label="⌫" onClick={back} />
        {keys.map((k) => <CalcKey key={k} label={k} onClick={() => append(k)} tone={"/*-+%".includes(k) ? "op" : "num"} />)}
        <button onClick={evaluate} className="col-span-4 mt-1 border border-maroon bg-maroon py-2 font-mono text-[13px] text-paper hover:bg-maroon/90">=</button>
      </div>
    </Panel>
  );
}

function CalcKey({ label, onClick, tone = "num" }: { label: string; onClick: () => void; tone?: "num" | "op" | "alert" }) {
  const cls = tone === "alert" ? "border-alert/50 text-alert" : tone === "op" ? "border-line-strong bg-paper-raised text-maroon" : "border-line-strong text-ink";
  return <button onClick={onClick} className={`border py-2 font-mono text-[13px] hover:bg-paper-raised ${cls}`}>{label}</button>;
}

// Tokenises and evaluates a basic arithmetic expression (+ - * / % and parens)
// WITHOUT eval() — a small shunting-yard evaluator so no arbitrary code runs.
function safeEval(input: string): number | null {
  const tokens = input.match(/(\d+\.?\d*|\.\d+|[()+\-*/%])/g);
  if (!tokens || tokens.join("") !== input.replace(/\s+/g, "")) return null;
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };
  const output: (number | string)[] = [];
  const ops: string[] = [];
  const apply = () => { ops.length && output.push(ops.pop() as string); };
  for (const tk of tokens) {
    if (/^[\d.]+$/.test(tk)) output.push(parseFloat(tk));
    else if (tk === "(") ops.push(tk);
    else if (tk === ")") { while (ops.length && ops[ops.length - 1] !== "(") apply(); ops.pop(); }
    else { while (ops.length && ops[ops.length - 1] !== "(" && prec[ops[ops.length - 1]] >= prec[tk]) apply(); ops.push(tk); }
  }
  while (ops.length) apply();
  const st: number[] = [];
  for (const t of output) {
    if (typeof t === "number") st.push(t);
    else {
      const b = st.pop(); const a = st.pop();
      if (a === undefined || b === undefined) return null;
      st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : t === "%" ? a % b : a / b);
    }
  }
  return st.length === 1 ? st[0] : null;
}

// ── Scratch pad ─────────────────────────────────────────────────────────────
function ScratchPad({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext("2d"); if (!ctx) return;
    const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d"); if (!ctx) return;
    const p = pos(e); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#1a1a1a";
    ctx.lineTo(p.x, p.y); ctx.stroke();
  };
  const end = () => { drawing.current = false; };
  const clear = () => {
    const c = canvasRef.current; const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
  };

  return (
    <Panel title="Rough sheet" onClose={onClose} className="w-[340px]">
      <canvas
        ref={canvasRef}
        width={316}
        height={240}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="w-full touch-none border border-line-strong bg-white"
      />
      <button onClick={clear} className="mt-2 w-full border border-line-strong py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">Clear sheet</button>
    </Panel>
  );
}

function Panel({ title, onClose, className = "", children }: { title: string; onClose: () => void; className?: string; children: React.ReactNode }) {
  return (
    <div className={`fixed bottom-4 right-4 z-50 border border-line-strong bg-paper p-3 shadow-2xl sm:right-6 ${className}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{title}</span>
        <button onClick={onClose} className="font-mono text-[13px] leading-none text-ink-soft hover:text-alert">×</button>
      </div>
      {children}
    </div>
  );
}
