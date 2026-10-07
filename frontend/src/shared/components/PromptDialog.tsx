import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

type PromptOptions = {
  title: string;
  detail?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  multiline?: boolean;
};

type Pending = PromptOptions & { resolve: (value: string | null) => void };

/**
 * In-app replacement for window.prompt. Render `dialog` once in the page and
 * `await ask({...})`: resolves to the trimmed text, or null when cancelled.
 */
export function usePromptDialog(): [ReactElement | null, (opts: PromptOptions) => Promise<string | null>] {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (opts: PromptOptions) => new Promise<string | null>((resolve) => setPending({ ...opts, resolve })),
    [],
  );
  const finish = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
  };
  const dialog = pending ? <PromptDialog key={pending.title} opts={pending} onDone={finish} /> : null;
  return [dialog, ask];
}

function PromptDialog({ opts, onDone }: { opts: PromptOptions; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(opts.defaultValue ?? "");
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  const submit = () => {
    const text = value.trim();
    if (text) onDone(text);
  };
  const field = "mt-4 w-full border border-line bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <form className="w-full max-w-md border border-line bg-paper p-6 shadow-xl" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 id="prompt-dialog-title" className="font-serif text-xl font-semibold">{opts.title}</h2>
        {opts.detail && <p className="mt-1.5 text-[13px] text-soft">{opts.detail}</p>}
        {opts.multiline ? (
          <textarea
            ref={inputRef}
            rows={4}
            value={value}
            placeholder={opts.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            className={`${field} resize-y`}
          />
        ) : (
          <input ref={inputRef} value={value} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} className={field} />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(null)} className="border border-line px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-soft hover:text-ink">Cancel</button>
          <button type="submit" disabled={!value.trim()} className="border border-forest bg-forest px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-paper disabled:opacity-50">{opts.confirmLabel ?? "Send"}</button>
        </div>
      </form>
    </div>
  );
}
