import * as fs from 'fs';

const filePath = 'src/pages/TeacherStudents.tsx';

const newCode = `import { useMemo, useState, useEffect, type FormEvent } from "react";
import { getExamRoster, enrollStudent, bulkEnrollStudents, removeStudentFromExam, type StudentRosterRecord } from "../lib/examApi";

type Exam = { id: string; name: string; batch: string; state: string; tone: string };

type Student = {
  roll: string;
  name: string;
  email: string;
  source: "existing" | "manual" | "bulk";
};

export default function TeacherStudents({ exams, navigate, notify }: { exams: Exam[]; navigate: (path: string) => void; notify: (message: string) => void }) {
  const [batch, setBatch] = useState<Exam | null>(exams[0] ?? null);
  const [roster, setRoster] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [method, setMethod] = useState<"manual" | "bulk">("manual");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ roll: "", name: "", email: "" });
  const [bulkFile, setBulkFile] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!batch) return;
    setLoading(true);
    getExamRoster(batch.id).then(records => {
      setRoster(records.map(r => ({ roll: r.roll, name: r.full_name, email: r.email, source: "existing" })));
      setLoading(false);
    });
  }, [batch]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? roster.filter((r) => \`\${r.roll} \${r.name} \${r.email}\`.toLowerCase().includes(q)) : roster;
  }, [roster, search]);

  const addManual = async () => {
    if (!batch) return;
    const roll = form.roll.trim().toUpperCase();
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    
    if (!roll || !name || !email) {
      setError("Roll number, name and email are all required.");
      return;
    }
    if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    
    const { error: apiErr } = await enrollStudent(batch.id, { roll, name, email, batch: batch.batch });
    if (apiErr) {
      setError("Error adding student: " + apiErr);
      return;
    }

    if (!roster.some((r) => r.roll === roll)) {
      setRoster((cur) => [{ roll, name, email, source: "manual" }, ...cur]);
    }
    
    setForm({ roll: "", name: "", email: "" });
    setError("");
    notify(\`\${name} added to the roster\`);
  };

  const remove = async (roll: string) => {
    if (!batch) return;
    const { error: apiErr } = await removeStudentFromExam(batch.id, roll);
    if (apiErr) {
      notify("Failed to remove student: " + apiErr);
      return;
    }
    setRoster((cur) => cur.filter((r) => r.roll !== roll));
    notify(\`\${roll} removed\`);
  };

  const downloadTemplate = () => {
    const tag = batch?.id ?? "batch";
    const header = "roll_no,full_name,email\\n";
    const sample = \`21VGN0999,Sample Student,21vgn0999@vignan.ac.in\\n\`;
    const blanks = ",,\\n".repeat(8);
    const blob = new Blob([header + sample + blanks], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`\${tag}-students-template.csv\`;
    a.click();
    URL.revokeObjectURL(url);
    notify(\`Student template for \${tag} downloaded\`);
  };

  const downloadRoster = () => {
    const tag = batch?.id ?? "batch";
    const header = "roll_no,full_name,email\\n";
    const rows = roster.map(r => \`\${r.roll},\${r.name},\${r.email}\\n\`).join("");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`\${tag}-students-roster.csv\`;
    a.click();
    URL.revokeObjectURL(url);
    notify(\`Roster for \${tag} downloaded\`);
  };

  const onBulkStage = (file: File | undefined) => {
    if (!file || !batch) return;
    setBulkFile(file.name);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\\n').filter(l => l.trim().length > 0);
      
      const parsed: {roll: string, name: string, email: string}[] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(s => s.trim());
        if (parts.length >= 3 && parts[0]) {
           parsed.push({ roll: parts[0].toUpperCase(), name: parts[1], email: parts[2] });
        }
      }
      
      if (parsed.length > 0) {
        const { count, error } = await bulkEnrollStudents(batch.id, batch.batch, parsed);
        if (error) {
           notify("Failed to import students: " + error);
           return;
        }
        
        // Refresh roster
        const records = await getExamRoster(batch.id);
        setRoster(records.map(r => ({ roll: r.roll, name: r.full_name, email: r.email, source: "existing" })));
        
        notify(\`\${count} students imported from \${file.name}\`);
      } else {
        notify("No valid student rows found in CSV");
      }
    };
    reader.readAsText(file);
  };

  const counts = {
    total: roster.length,
    manual: roster.filter((r) => r.source === "manual").length,
    bulk: roster.filter((r) => r.source === "bulk").length,
  };

  return (
    <div className="space-y-6">
      <StuHeader batch={batch} exams={exams} onBatch={setBatch} counts={counts} onExams={() => navigate("/teacher/exams")} onExport={downloadRoster} />

      <AddStudents
        method={method}
        setMethod={setMethod}
        form={form}
        setForm={setForm}
        error={error}
        onAdd={addManual}
        batch={batch}
        bulkFile={bulkFile}
        onTemplate={downloadTemplate}
        onStage={onBulkStage}
      />

      <RosterTable loading={loading} visible={visible} total={roster.length} search={search} setSearch={setSearch} onRemove={remove} />
    </div>
  );
}

function StuHeader({ batch, exams, onBatch, counts, onExams, onExport }: { batch: Exam | null; exams: Exam[]; onBatch: (e: Exam | null) => void; counts: { total: number; manual: number; bulk: number }; onExams: () => void; onExport: () => void; }) {
  return (
    <div className="border border-line bg-paper p-6 sm:p-7">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Students</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">Manage your class roster</h1>
          <p className="mt-2 max-w-xl text-[13px] text-ink-soft">
            Add the students who will sit an exam — one at a time or by importing the whole class. Rosters feed the join-link email that goes out when you publish.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4 sm:gap-6">
          <StatChip label="On roster" value={String(counts.total)} />
          <StatChip label="Manual" value={String(counts.manual)} />
          <StatChip label="Imported" value={String(counts.bulk)} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-5">
        <label className="text-[11px] text-ink-soft">
          Batch / exam
          <select
            value={batch?.id ?? ""}
            onChange={(e) => onBatch(exams.find((x) => x.id === e.target.value) ?? null)}
            className="mt-1 block min-w-[280px] border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest"
          >
            {exams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} — {x.name}
              </option>
            ))}
          </select>
        </label>

        {batch && <p className="pb-2 text-[12px] text-ink-soft">{batch.batch}</p>}
        
        <div className="ml-auto flex items-center gap-3">
          <button onClick={onExport} className="border border-line-strong px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest">
            Export CSV ↓
          </button>
          <button onClick={onExams} className="border border-line-strong px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest">
            Manage exams →
          </button>
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[70px] text-center">
      <p className="font-serif text-[26px] leading-none text-ink">{value}</p>
      <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
    </div>
  );
}

function AddStudents(props: { method: "manual" | "bulk"; setMethod: (m: "manual" | "bulk") => void; form: { roll: string; name: string; email: string }; setForm: (f: { roll: string; name: string; email: string }) => void; error: string; onAdd: () => void; batch: Exam | null; bulkFile: string | null; onTemplate: () => void; onStage: (f: File | undefined) => void }) {
  const { method, setMethod } = props;
  return (
    <section className="border border-line bg-paper">
      <div className="flex flex-wrap items-stretch gap-1 border-b border-line px-3 pt-3">
        <Tab active={method === "manual"} onClick={() => setMethod("manual")} label="Add manually" hint="One student at a time" />
        <Tab active={method === "bulk"} onClick={() => setMethod("bulk")} label="Bulk upload" hint="Import a whole class list" />
      </div>
      <div className="p-6 sm:p-8">
        {method === "manual"
          ? <ManualForm form={props.form} setForm={props.setForm} error={props.error} onAdd={props.onAdd} />
          : <BulkPanel batch={props.batch} bulkFile={props.bulkFile} onTemplate={props.onTemplate} onStage={props.onStage} />}
      </div>
    </section>
  );
}
function Tab({ active, onClick, label, hint }: { active: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button onClick={onClick} className={\`-mb-px border-b-2 px-5 py-3 text-left transition \${active ? "border-forest" : "border-transparent hover:border-line-strong"}\`}>
      <span className={\`block font-serif text-[17px] font-semibold \${active ? "text-ink" : "text-ink-soft"}\`}>{label}</span>
      <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-widest text-ink-soft">{hint}</span>
    </button>
  );
}
function ManualForm({ form, setForm, error, onAdd }: { form: { roll: string; name: string; email: string }; setForm: (f: { roll: string; name: string; email: string }) => void; error: string; onAdd: () => void }) {
  const field = (k: "roll" | "name" | "email", v: string) => setForm({ ...form, [k]: v });
  const submit = (e: FormEvent) => { e.preventDefault(); onAdd(); };
  return (
    <form onSubmit={submit}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Enter student details</p>
      <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Add one student to the roster. They receive the exam join link by email the moment you publish.</p>
      <div className="mt-6 grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <label className="block text-[11px] uppercase tracking-wider text-ink-soft">Roll number
          <input value={form.roll} onChange={(e) => field("roll", e.target.value)} placeholder="21VGN0210" className="mt-1.5 block w-full border border-line-strong bg-paper px-3 py-3 font-mono text-[14px] uppercase outline-none focus:border-forest" />
        </label>
        <label className="block text-[11px] uppercase tracking-wider text-ink-soft">Full name
          <input value={form.name} onChange={(e) => field("name", e.target.value)} placeholder="R. Ananya" className="mt-1.5 block w-full border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest" />
        </label>
        <label className="block text-[11px] uppercase tracking-wider text-ink-soft">Email
          <input type="email" value={form.email} onChange={(e) => field("email", e.target.value)} placeholder="21vgn0210@vignan.ac.in" className="mt-1.5 block w-full border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest" />
        </label>
        <button type="submit" className="border border-forest bg-forest px-8 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-light">+ Add student</button>
      </div>
      {error && <p className="mt-4 border border-alert/40 bg-alert/5 px-4 py-2.5 text-[13px] text-alert">{error}</p>}
    </form>
  );
}
function BulkPanel({ batch, bulkFile, onTemplate, onStage }: { batch: Exam | null; bulkFile: string | null; onTemplate: () => void; onStage: (f: File | undefined) => void }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Import a class list</p>
      <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Download the CSV template{batch ? <> — it is tagged for <span className="font-mono text-[12px] text-ink">{batch.id}</span></> : ""}, fill in one student per row, then upload it back to enrol the whole class at once.</p>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col justify-between border border-line bg-paper-raised p-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 1 — Template</p>
            <p className="mt-2 text-[13px] text-ink-soft">Columns: <span className="font-mono text-[12px] text-ink">roll_no, full_name, email</span></p>
          </div>
          <button onClick={onTemplate} className="mt-5 w-full border border-line-strong bg-paper py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">↓ Download CSV template</button>
        </div>
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed border-line-strong bg-paper-raised px-6 py-10 text-center hover:border-forest">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 2 — Upload</span>
          <span className="font-serif text-[16px] text-ink">{bulkFile ? \`✓ \${bulkFile}\` : "Drop or choose your CSV"}</span>
          <span className="text-[12px] text-ink-soft">{bulkFile ? "Imported. Choose another file to replace." : "Click to browse for the filled-in template"}</span>
          <input type="file" accept=".csv" className="hidden" onChange={(e) => onStage(e.target.files?.[0])} />
        </label>
      </div>
    </div>
  );
}

function RosterTable({ loading, visible, total, search, setSearch, onRemove }: { loading: boolean; visible: Student[]; total: number; search: string; setSearch: (v: string) => void; onRemove: (roll: string) => void }) {
  return (
    <section className="border border-line bg-paper">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Current roster</p>
          <p className="mt-0.5 text-[13px]">
            <span className="font-serif text-lg">{total}</span> student{total === 1 ? "" : "s"} enrolled
          </p>
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search roll, name, email"
          className="w-full max-w-[250px] border border-line-strong bg-paper px-3 py-2 text-[12px] outline-none focus:border-forest"
        />
      </div>

      {loading ? (
        <div className="px-5 py-16 text-center">
          <p className="font-serif text-lg text-ink-soft">Loading roster...</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="px-5 py-16 text-center">
          <p className="font-serif text-lg text-ink-soft">{total === 0 ? "No students yet" : "No matches"}</p>
          <p className="mt-1 text-[12px] text-ink-soft">
            {total === 0 ? "Add students manually or import a class list to get started." : "Try a different search term."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-line">
          <div className="hidden grid-cols-[130px_minmax(0,1fr)_60px] gap-4 px-5 py-2.5 font-mono text-[9px] uppercase tracking-widest text-ink-soft sm:grid">
            <span>Roll no</span>
            <span>Name &amp; email</span>
            <span className="text-right">Actions</span>
          </div>

          {visible.map((r) => (
            <RosterRow key={r.roll} student={r} onRemove={onRemove} />
          ))}
        </div>
      )}
    </section>
  );
}

function RosterRow({ student, onRemove }: { student: Student; onRemove: (roll: string) => void }) {
  const tag = student.source === "manual" ? "Manual" : student.source === "bulk" ? "Imported" : "Existing";

  return (
    <div className="grid grid-cols-1 gap-1 px-5 py-3 text-[13px] hover:bg-paper-raised sm:grid-cols-[130px_minmax(0,1fr)_60px] sm:items-center sm:gap-4">
      <span className="font-mono text-[12px]">{student.roll}</span>
      <span className="min-w-0">
        <span className="block truncate">{student.name}</span>
        <span className="block truncate text-[11px] text-ink-soft">
          {student.email} · <span className="uppercase tracking-wider">{tag}</span>
        </span>
      </span>
      <span className="text-left sm:text-right">
        <button onClick={() => onRemove(student.roll)} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-alert">
          Remove
        </button>
      </span>
    </div>
  );
}
`;

fs.writeFileSync(filePath, newCode);
console.log('TeacherStudents rewritten successfully.');
