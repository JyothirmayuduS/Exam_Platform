import { useState } from "react";
import { useSearchParams } from "react-router-dom";

export default function MobileUpload() {
  const [searchParams] = useSearchParams();
  const examId = searchParams.get("examId") || "Unknown Exam";
  const qId = searchParams.get("qId") || "Unknown Question";
  const studentId = searchParams.get("student") || "Unknown Student";

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    
    // Simulate Supabase upload
    setTimeout(() => {
      setUploading(false);
      setDone(true);
      // In a real app with Supabase, we would push to a realtime channel here
      // so the desktop app can automatically download and compile the PDF using jspdf.
    }, 2000);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-ink">
      <div className="w-full max-w-sm rounded border border-line bg-paper-raised p-6 shadow-sm">
        <h1 className="mb-2 text-center font-serif text-2xl font-semibold">Subjective Upload</h1>
        <p className="mb-6 text-center text-sm text-ink-soft">Scan or take a photo of your handwritten answer sheet.</p>
        
        {done ? (
          <div className="flex flex-col items-center justify-center py-6">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
              <span className="text-xl text-success">✓</span>
            </div>
            <p className="font-mono text-[13px] font-bold uppercase tracking-wider text-success">Upload Complete</p>
            <p className="mt-2 text-center text-[12px] text-ink-soft">
              Your answer has been sent to the exam browser. You may close this tab.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-6 space-y-1 font-mono text-[11px] uppercase tracking-wider text-ink-soft">
              <div className="flex justify-between border-b border-line pb-1">
                <span>Exam ID</span> <span className="text-ink">{examId}</span>
              </div>
              <div className="flex justify-between border-b border-line pb-1 pt-1">
                <span>Question</span> <span className="text-ink">{qId}</span>
              </div>
              <div className="flex justify-between pt-1">
                <span>Roll No</span> <span className="text-ink">{studentId}</span>
              </div>
            </div>
            
            <label className="mb-4 block w-full cursor-pointer rounded border border-dashed border-ink-soft bg-paper py-8 text-center transition-colors hover:bg-line/20">
              <span className="font-mono text-[12px] uppercase tracking-wider text-ink">
                {file ? file.name : "Tap to Camera / Gallery"}
              </span>
              <input 
                type="file" 
                accept="image/*" 
                capture="environment"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="hidden"
              />
            </label>

            <button 
              onClick={handleUpload}
              disabled={uploading || !file}
              className="w-full border border-ink bg-ink py-3 font-mono text-[12px] uppercase tracking-widest text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft"
            >
              {uploading ? "Uploading..." : "Submit Answer"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
