import * as fs from 'fs';

const filePath = 'src/pages/TeacherQuestionSetup.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// Update Settings type
if (!content.includes('photoId: boolean;')) {
  content = content.replace(
    'negative: boolean; calculator: boolean; instantFeedback: boolean;',
    'negative: boolean; calculator: boolean; instantFeedback: boolean;\n  photoId: boolean; violationLimit: number; violationAction: "warn" | "submit"; releaseDate: string; ipWhitelist: string; sections: boolean;'
  );

  // Update default state
  content = content.replace(
    'attempts: 1, negative: false, calculator: false, instantFeedback: false',
    'attempts: 1, negative: false, calculator: false, instantFeedback: false, photoId: false, violationLimit: 3, violationAction: "submit", releaseDate: "", ipWhitelist: "", sections: false'
  );

  // Update StepRules UI
  // 1. Add Section/group support to Question Delivery
  content = content.replace(
    '<ToggleRow label="Shuffle answer options"',
    '<ToggleRow label="Enable sections/groups" detail="Group questions by unit or topic instead of a single list." checked={s.sections} onChange={(v) => set("sections", v)} />\n          <ToggleRow label="Shuffle answer options"'
  );

  // 2. Add Security & Violations section right after Mode
  const securitySection = `
        <section className="border border-line bg-paper p-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Security & Access</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">Proctoring and restrictions</h2>
          <ToggleRow label="Require Photo ID verification" detail="Students must capture their face and ID card before starting." checked={s.photoId} onChange={(v) => set("photoId", v)} />
          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[12px] font-medium">Violation thresholds</p>
            <p className="mt-1 text-[11px] text-ink-soft">What happens when a candidate triggers multiple proctoring flags?</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <NumField label="Maximum flags allowed" hint="Before action is taken" value={s.violationLimit} min={1} max={20} onChange={(v) => set("violationLimit", v)} />
              <label className="block text-[12px] text-ink-soft">
                <span className="font-medium text-ink">Action to take</span><span className="mt-0.5 block text-[11px]">When threshold is met</span>
                <select value={s.violationAction} onChange={(e) => set("violationAction", e.target.value as any)} className="mt-2 block w-full border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest">
                  <option value="warn">Warn student only</option>
                  <option value="submit">Auto-submit exam</option>
                </select>
              </label>
            </div>
          </div>
          <div className="mt-5 border-t border-line pt-4">
             <label className="block text-[12px] text-ink-soft">
                <span className="font-medium text-ink">IP Whitelist (Optional)</span><span className="mt-0.5 block text-[11px]">Restrict access to campus network. Comma-separated IPs.</span>
                <input value={s.ipWhitelist} onChange={(e) => set("ipWhitelist", e.target.value)} placeholder="e.g. 192.168.1.1, 10.0.0.0/8" className="mt-2 block w-full border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest" />
              </label>
          </div>
        </section>
`;
  content = content.replace(
    '</section>\n        <section className="border border-line bg-paper p-6">\n          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Question delivery</p>',
    `</section>\n${securitySection}\n        <section className="border border-line bg-paper p-6">\n          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Question delivery</p>`
  );

  // 3. Add Auto-release date to Rules & scoring
  content = content.replace(
    '<ToggleRow label="Negative marking"',
    `<div className="mt-5 border-t border-line pt-4 pb-4">
            <label className="block text-[12px] text-ink-soft">
                <span className="font-medium text-ink">Result auto-release date</span><span className="mt-0.5 block text-[11px]">When students can view their final score (leave blank for manual).</span>
                <input type="datetime-local" value={s.releaseDate} onChange={(e) => set("releaseDate", e.target.value)} className="mt-2 block w-full border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest" />
            </label>
          </div>
          <ToggleRow label="Negative marking"`
  );
  
  // 4. Update RulesPreview to include some of the new fields
  content = content.replace(
    '<PreviewRow label="Attempts" value={s.mode === "practice" ? String(s.attempts) : "1"} />',
    `<PreviewRow label="Attempts" value={s.mode === "practice" ? String(s.attempts) : "1"} />
          <PreviewRow label="Security" value={s.photoId ? "ID req." : "Standard"} />
          <PreviewRow label="Violations" value={\`Max \${s.violationLimit} → \${s.violationAction}\`} />
          <PreviewRow label="Sections" value={s.sections ? "Enabled" : "Off"} />
          {s.releaseDate && <PreviewRow label="Release" value={new Date(s.releaseDate).toLocaleDateString()} />}`
  );

  fs.writeFileSync(filePath, content);
  console.log('TeacherQuestionSetup patched for full Exam Configuration features');
} else {
  console.log('Already patched');
}
