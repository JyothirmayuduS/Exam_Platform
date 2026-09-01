import * as fs from 'fs';

const filePath = 'src/components/teacher/ExamWizard.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add enrollEntireBatch import
content = content.replace(
  'import { publishExam, type ExamRecord } from "../../lib/examApi";',
  'import { publishExam, enrollEntireBatch, type ExamRecord } from "../../lib/examApi";'
);

// 2. Add enrollmentMode state
content = content.replace(
  'const [title, setTitle] = useState("");',
  'const [title, setTitle] = useState("");\n  const [enrollmentMode, setEnrollmentMode] = useState<"all" | "manual">("all");'
);

// 3. Update handleCreate
const oldHandleCreate = `  const handleCreate = async () => {
    const id = \`EXAM-\${new Date().getFullYear()}-\${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}\`;
    const newExam: ExamRecord = {
      id,
      name: title || "Untitled Exam",
      batch,
      duration_minutes: parseInt(duration),
      mode: "lockdown",
      status: "published",
      created_at: new Date().toISOString(),
    };
    
    // Publish
    const { error } = await publishExam(newExam, []); // Pass questions if available from context
    
    if (error) {
      notify("Failed to publish exam: " + error);
      return;
    }

    notify(\`\${id} published successfully\`);
    onComplete();
  };`;

const newHandleCreate = `  const handleCreate = async () => {
    const id = \`EXAM-\${new Date().getFullYear()}-\${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}\`;
    const newExam: ExamRecord = {
      id,
      name: title || "Untitled Exam",
      batch,
      duration_minutes: parseInt(duration),
      mode: "lockdown",
      status: "published",
      created_at: new Date().toISOString(),
    };
    
    // Publish
    const { error } = await publishExam(newExam, []); 
    
    if (error) {
      notify("Failed to publish exam: " + error);
      return;
    }

    if (enrollmentMode === "all") {
      await enrollEntireBatch(id, batch);
      notify(\`\${id} published. Entire \${batch} enrolled.\`);
    } else {
      notify(\`\${id} published. You can add students manually from the Students tab.\`);
    }
    
    onComplete();
  };`;

content = content.replace(oldHandleCreate, newHandleCreate);

// 4. Update Review UI
const oldReviewUI = `              <label className="mt-5 flex gap-3 text-[12px] text-ink-soft">
                <input type="checkbox" defaultChecked className="mt-0.5 accent-forest"/>
                I confirm the exam details and question set are ready for candidates.
              </label>`;

const newReviewUI = `              <div className="mt-6 border border-line p-5">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student Enrollment</p>
                <div className="mt-3 flex flex-col gap-2 text-[13px]">
                  <label className="flex items-center gap-3">
                    <input type="radio" name="enroll" checked={enrollmentMode === "all"} onChange={() => setEnrollmentMode("all")} className="accent-forest" />
                    Enroll all students currently in the <strong>{batch}</strong> batch
                  </label>
                  <label className="flex items-center gap-3">
                    <input type="radio" name="enroll" checked={enrollmentMode === "manual"} onChange={() => setEnrollmentMode("manual")} className="accent-forest" />
                    I will enroll specific students later from the Students tab
                  </label>
                </div>
              </div>
              <label className="mt-5 flex gap-3 text-[12px] text-ink-soft">
                <input type="checkbox" defaultChecked className="mt-0.5 accent-forest"/>
                I confirm the exam details and question set are ready for candidates.
              </label>`;

content = content.replace(oldReviewUI, newReviewUI);

fs.writeFileSync(filePath, content);
console.log('ExamWizard patched');
