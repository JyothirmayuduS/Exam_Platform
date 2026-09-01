import * as fs from 'fs';

const filePath = 'src/pages/TeacherQuestionSetup.tsx';
let content = fs.readFileSync(filePath, 'utf8');

if (!content.includes('autoClose: boolean;')) {
  // Update Settings type
  content = content.replace(
    'sectionTiming: boolean;',
    'sectionTiming: boolean; autoClose: boolean; durationLock: boolean;'
  );

  // Update default state
  content = content.replace(
    'sectionTiming: false }',
    'sectionTiming: false, autoClose: false, durationLock: true }'
  );

  // Add durationLock to Question delivery
  content = content.replace(
    '<ToggleRow label="Randomly select questions"',
    '<ToggleRow label="Duration lock (strict)" detail="Prevent time extension requests during the exam." checked={s.durationLock} onChange={(v) => set("durationLock", v)} />\n          <ToggleRow label="Randomly select questions"'
  );

  // Add autoClose to Rules & scoring
  content = content.replace(
    '<ToggleRow label="Auto-submit when time runs out"',
    '<ToggleRow label="Auto-close at deadline" detail="Force submit if the scheduled exam window ends, regardless of remaining time." checked={s.autoClose} onChange={(v) => set("autoClose", v)} />\n          <ToggleRow label="Auto-submit when time runs out"'
  );

  fs.writeFileSync(filePath, content);
  console.log('TeacherQuestionSetup patched with Auto-close and Duration lock');
} else {
  console.log('Already patched');
}
