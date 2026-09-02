import { useMemo, useState, useEffect } from "react";
import { getExamRoster, bulkEnrollStudents, removeStudentFromExam, getStudentsByBranchAndSection, bulkImportGlobalStudents, type Student as DBStudent } from "../lib/examApi";

type Exam = { id: string; name: string; batch: string; state: string; tone: string };

type Student = {
  roll: string;
  name: string;
  email: string;
  branch: string;
  section: string;
  phone?: string | null;
  source: "existing" | "manual" | "bulk";
};

export default function TeacherStudents({ exams, navigate, notify }: { exams: Exam[]; navigate: (path: string) => void; notify: (message: string) => void }) {
  const [batch, setBatch] = useState<Exam | null>(exams[0] ?? null);
  const [roster, setRoster] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [method, setMethod] = useState<"directory" | "bulk">("directory");
  const [search, setSearch] = useState("");

  const loadRoster = async (examId: string) => {
    setLoading(true);
    const records = await getExamRoster(examId);
    setRoster(records.map(r => ({ roll: r.roll, name: r.full_name, email: r.email, branch: r.branch, section: r.section, phone: r.phone, source: "existing" })));
    setLoading(false);
  };

  useEffect(() => {
    if (!batch) return;
    loadRoster(batch.id);
  }, [batch]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? roster.filter((r) => `${r.roll} ${r.name} ${r.email}`.toLowerCase().includes(q)) : roster;
  }, [roster, search]);

  const remove = async (roll: string) => {
    if (!batch) return;
    const { error: apiErr } = await removeStudentFromExam(batch.id, roll);
    if (apiErr) {
      notify("Failed to remove student: " + apiErr);
      return;
    }
    setRoster((cur) => cur.filter((r) => r.roll !== roll));
    notify(`${roll} removed`);
  };

  const downloadRoster = () => {
    const tag = batch?.id ?? "batch";
    const header = "roll_no,full_name,email,branch,section,phone\n";
    const rows = roster.map(r => `${r.roll},${r.name},${r.email},${r.branch},${r.section},${r.phone ?? ""}\n`).join("");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tag}-students-roster.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify(`Roster for ${tag} downloaded`);
  };

  const counts = {
    total: roster.length,
  };

  return (
    <div className="space-y-6">
      <StuHeader batch={batch} exams={exams} onBatch={setBatch} counts={counts} onExams={() => navigate("/teacher/exams")} onExport={downloadRoster} />

      <GlobalStudentPicker
        method={method}
        setMethod={setMethod}
        batch={batch}
        notify={notify}
        onEnrolled={() => batch && loadRoster(batch.id)}
      />

      <RosterTable loading={loading} visible={visible} total={roster.length} search={search} setSearch={setSearch} onRemove={remove} />
    </div>
  );
}

function StuHeader({ batch, exams, onBatch, counts, onExams, onExport }: { batch: Exam | null; exams: Exam[]; onBatch: (e: Exam | null) => void; counts: { total: number; }; onExams: () => void; onExport: () => void; }) {
  return (
    <div className="border border-line bg-paper p-6 sm:p-7">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Students</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">Manage your class roster</h1>
          <p className="mt-2 max-w-xl text-[13px] text-ink-soft">
            Select an exam below, then use the Global Directory to enroll students based on their branch and section.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:gap-6">
          <StatChip label="On roster" value={String(counts.total)} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-5">
        <label className="text-[11px] text-ink-soft">
          Select Exam
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

function GlobalStudentPicker({ method, setMethod, batch, notify, onEnrolled }: { method: "directory" | "bulk"; setMethod: (m: "directory" | "bulk") => void; batch: Exam | null; notify: (m: string) => void; onEnrolled: () => void; }) {
  return (
    <section className="border border-line bg-paper">
      <div className="flex flex-wrap items-stretch gap-1 border-b border-line px-3 pt-3">
        <Tab active={method === "directory"} onClick={() => setMethod("directory")} label="Global Directory" hint="Filter and select students" />
        <Tab active={method === "bulk"} onClick={() => setMethod("bulk")} label="Global Bulk Import" hint="Upload master CSV" />
      </div>
      <div className="p-6 sm:p-8">
        {method === "directory"
          ? <DirectoryPicker batch={batch} notify={notify} onEnrolled={onEnrolled} />
          : <BulkGlobalPanel notify={notify} />}
      </div>
    </section>
  );
}

function Tab({ active, onClick, label, hint }: { active: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button onClick={onClick} className={`-mb-px border-b-2 px-5 py-3 text-left transition ${active ? "border-forest" : "border-transparent hover:border-line-strong"}`}>
      <span className={`block font-serif text-[17px] font-semibold ${active ? "text-ink" : "text-ink-soft"}`}>{label}</span>
      <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-widest text-ink-soft">{hint}</span>
    </button>
  );
}

function DirectoryPicker({ batch, notify, onEnrolled }: { batch: Exam | null; notify: (m: string) => void; onEnrolled: () => void; }) {
  const [branch, setBranch] = useState("CSE");
  const [section, setSection] = useState("A");
  const [students, setStudents] = useState<DBStudent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  const fetchStudents = async () => {
    setLoading(true);
    const results = await getStudentsByBranchAndSection(branch, section);
    setStudents(results);
    setSelectedIds(new Set());
    setLoading(false);
  };

  const handleEnroll = async () => {
    if (!batch) {
      notify("Select an exam first");
      return;
    }
    if (selectedIds.size === 0) {
      notify("Select at least one student");
      return;
    }

    setEnrolling(true);
    const selectedStudents = students.filter(s => selectedIds.has(s.id)).map(s => ({ id: s.id }));
    const { count, error } = await bulkEnrollStudents(batch.id, selectedStudents);
    setEnrolling(false);

    if (error) {
      notify("Failed to enroll: " + error);
    } else {
      notify(`Successfully enrolled ${count} students`);
      onEnrolled();
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === students.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(students.map(s => s.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Filter Directory</p>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="block text-[11px] uppercase tracking-wider text-ink-soft">Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)} className="mt-1.5 block w-48 border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest">
            <option value="CSE">CSE</option>
            <option value="ECE">ECE</option>
            <option value="IT">IT</option>
            <option value="MECH">MECH</option>
            <option value="CIVIL">CIVIL</option>
          </select>
        </label>
        <label className="block text-[11px] uppercase tracking-wider text-ink-soft">Section
          <select value={section} onChange={(e) => setSection(e.target.value)} className="mt-1.5 block w-32 border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest">
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
            <option value="E">E</option>
          </select>
        </label>
        <button onClick={fetchStudents} disabled={loading} className="border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest disabled:opacity-50">
          {loading ? "Fetching..." : "Fetch Students"}
        </button>
      </div>

      {students.length > 0 && (
        <div className="mt-8 border border-line bg-paper-raised">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <label className="flex items-center gap-3 text-[13px] font-medium cursor-pointer">
              <input type="checkbox" checked={selectedIds.size === students.length && students.length > 0} onChange={toggleSelectAll} className="w-4 h-4 cursor-pointer accent-forest" />
              Select All ({selectedIds.size}/{students.length})
            </label>
            <button onClick={handleEnroll} disabled={enrolling || selectedIds.size === 0} className="border border-forest bg-forest px-6 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:opacity-50 disabled:cursor-not-allowed">
              {enrolling ? "Enrolling..." : `Enroll Selected`}
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-line">
            {students.map((s) => (
              <label key={s.id} className="flex items-center gap-4 px-5 py-3 hover:bg-paper cursor-pointer">
                <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} className="w-4 h-4 cursor-pointer accent-forest" />
                <span className="font-mono text-[12px] min-w-[100px]">{s.roll}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px]">{s.full_name}</span>
                  <span className="block truncate text-[11px] text-ink-soft">{s.email} {s.phone ? `· ${s.phone}` : ""}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {!loading && students.length === 0 && branch && section && (
        <p className="mt-6 text-[13px] text-ink-soft">Click 'Fetch Students' to see results, or no students found in this branch and section.</p>
      )}
    </div>
  );
}

function BulkGlobalPanel({ notify }: { notify: (m: string) => void; }) {
  const [bulkFile, setBulkFile] = useState<string | null>(null);

  const downloadTemplate = () => {
    const header = "roll_no,full_name,email,branch,section,phone\n";
    const sample = `21VGN0999,Sample Student,21vgn0999@vignan.ac.in,CSE,A,9876543210\n`;
    const blanks = ",,,,,\n".repeat(8);
    const blob = new Blob([header + sample + blanks], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `global-students-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify(`Global student template downloaded`);
  };

  const onStage = (file: File | undefined) => {
    if (!file) return;
    setBulkFile(file.name);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      
      const parsed: {roll: string, name: string, email: string, branch: string, section: string, phone: string}[] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(s => s.trim());
        if (parts.length >= 5 && parts[0]) {
           parsed.push({ roll: parts[0].toUpperCase(), name: parts[1], email: parts[2], branch: parts[3], section: parts[4], phone: parts[5] || "" });
        }
      }
      
      if (parsed.length > 0) {
        const { count, error } = await bulkImportGlobalStudents(parsed);
        if (error) {
           notify("Failed to import students globally: " + error);
        } else {
           notify(`Successfully imported ${count} students to global directory`);
        }
      } else {
        notify("No valid student rows found in CSV");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Populate Global Directory</p>
      <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Download the CSV template, fill in the details including branch and section, then upload it to populate the master database.</p>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col justify-between border border-line bg-paper-raised p-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 1 — Template</p>
            <p className="mt-2 text-[13px] text-ink-soft">Columns: <span className="font-mono text-[12px] text-ink">roll_no, full_name, email, branch, section, phone</span></p>
          </div>
          <button onClick={downloadTemplate} className="mt-5 w-full border border-line-strong bg-paper py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">↓ Download CSV template</button>
        </div>
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed border-line-strong bg-paper-raised px-6 py-10 text-center hover:border-forest">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 2 — Upload</span>
          <span className="font-serif text-[16px] text-ink">{bulkFile ? `✓ ${bulkFile}` : "Drop or choose your CSV"}</span>
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
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Enrolled Roster</p>
          <p className="mt-0.5 text-[13px]">
            <span className="font-serif text-lg">{total}</span> student{total === 1 ? "" : "s"} enrolled in this exam
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
          <p className="font-serif text-lg text-ink-soft">{total === 0 ? "No students enrolled yet" : "No matches"}</p>
          <p className="mt-1 text-[12px] text-ink-soft">
            {total === 0 ? "Use the directory above to enroll students." : "Try a different search term."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-line">
          <div className="hidden grid-cols-[130px_minmax(0,1fr)_100px_60px] gap-4 px-5 py-2.5 font-mono text-[9px] uppercase tracking-widest text-ink-soft sm:grid">
            <span>Roll no</span>
            <span>Name &amp; email</span>
            <span>Dept</span>
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
  return (
    <div className="grid grid-cols-1 gap-1 px-5 py-3 text-[13px] hover:bg-paper-raised sm:grid-cols-[130px_minmax(0,1fr)_100px_60px] sm:items-center sm:gap-4">
      <span className="font-mono text-[12px]">{student.roll}</span>
      <span className="min-w-0">
        <span className="block truncate">{student.name}</span>
        <span className="block truncate text-[11px] text-ink-soft">
          {student.email} {student.phone ? `· ${student.phone}` : ""}
        </span>
      </span>
      <span className="font-mono text-[11px] text-ink-soft">{student.branch} {student.section}</span>
      <span className="text-left sm:text-right">
        <button onClick={() => onRemove(student.roll)} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-alert">
          Remove
        </button>
      </span>
    </div>
  );
}
