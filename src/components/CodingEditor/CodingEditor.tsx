import React, { useRef, useEffect, useState } from "react";

// Monaco editor loaded from CDN; no external dependency needed.
// In a production bundle this would be a Vite import from @monaco-editor/react.

export type CodingLanguage = "python" | "javascript" | "java" | "cpp" | "csharp";

export interface CodingEditorProps {
  language: CodingLanguage;
  initialCode: string;
  onRun?: (code: string, lang: string) => Promise<{ stdout: string; stderr: string; exitCode: number; timeMs: number } | null>;
  onChange?: (code: string) => void;
}

export default function CodingEditor({ language, initialCode, onRun, onChange }: CodingEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [code, setCode] = useState(initialCode);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string>("");

  useEffect(() => {
    const win = window as any;
    if (!win.monaco) {
      // Load Monaco loader script if not present
      const loader = document.createElement("script");
      loader.src = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/loader.min.js";
      loader.onload = () => {
        const require = (win as any).require;
        require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs" } });
        require(["vs/editor/editor.main"], () => {
          const ed = win.monaco?.editor?.create;
          if (ed && editorRef.current && !editorRef.current.getAttribute("data-monaco")) {
            ed(editorRef.current, { value: code, language: language === "cpp" ? "cpp" : language, theme: "vs-dark", automaticLayout: true, minimap: { enabled: false } });
            editorRef.current.setAttribute("data-monaco", "1");
          }
        });
      };
      document.body.appendChild(loader);
    }
  }, [language, code]);

  const handleRun = async () => {
    if (!onRun) return;
    setRunning(true);
    setResult("");
    try {
      const res = await onRun(code, language);
      if (res) {
        setResult(`Exit code: ${res.exitCode}\nStdout:\n${res.stdout}\nStderr:\n${res.stderr}\nTime: ${res.timeMs}ms`);
      } else {
        setResult("Execution failed or no runner configured.");
      }
    } catch (e: any) {
      setResult("Run error: " + (e?.message || String(e)));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="coding-editor border border-line rounded-md overflow-hidden bg-paper">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper-raised">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Editor — {language}</span>
        <button onClick={handleRun} disabled={running} className="ml-auto rounded bg-forest text-[11px] px-3 py-1 text-paper hover:bg-forest-light disabled:opacity-50">{running ? "Running..." : "Run"}</button>
      </div>
      <div ref={editorRef} style={{ height: "400px", width: "100%" }} />
      {result && (
        <div className="border-t border-line bg-ink text-paper px-3 py-2 text-[11px] font-mono whitespace-pre-wrap min-h-[60px] overflow-auto max-h-[120px]">
          {result}
        </div>
      )}
    </div>
  );
}
