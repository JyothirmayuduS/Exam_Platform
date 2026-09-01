import * as fs from 'fs';

const filePath = 'src/pages/TeacherQuestionSetup.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// Add expandedRecipients state and allSelected logic
content = content.replace(
  'const [selectedMockStudents, setSelectedMockStudents] = useState<string[]>([]);',
  'const [selectedMockStudents, setSelectedMockStudents] = useState<string[]>([]);\n  const [expandedRecipients, setExpandedRecipients] = useState(false);\n  const allSelected = selectedMockStudents.length === MOCK_STUDENTS.length;\n  const toggleAll = () => setSelectedMockStudents(allSelected ? [] : MOCK_STUDENTS.map(s => s.id));'
);

// Add the actual list of recipients for the preview
const mockRecipientsCode = `
  const mockRecipients = enrollmentMode === "all" 
    ? Array.from({ length: ENROLLED }).map((_, i) => \`21vgn\${String(142 + i).padStart(4, '0')}@vignan.ac.in\`) 
    : selectedMockStudents.map(id => MOCK_STUDENTS.find(s => s.id === id)?.email).filter(Boolean) as string[];
  const visibleRecipients = expandedRecipients ? mockRecipients : mockRecipients.slice(0, 4);
`;
content = content.replace(
  'const ready = pool > 0;',
  'const ready = pool > 0;' + mockRecipientsCode
);

// Update "Select Students" header with "Select All" button
content = content.replace(
  '<p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft mb-2">Select Students</p>',
  `<div className="flex items-center justify-between mb-2">
                    <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Select Students</p>
                    <button type="button" onClick={toggleAll} className="font-mono text-[9px] uppercase tracking-wider text-forest hover:underline">
                      {allSelected ? "Deselect All" : "Select All"}
                    </button>
                  </div>`
);

// Update Recipients preview UI to use mockRecipients and toggle expandedRecipients
const oldPreview = '{RECIPIENTS.map((e) => <p key={e} className="truncate font-mono text-[11px] text-ink-soft">{e}</p>)}<p className="font-mono text-[11px] text-ink-soft">+ {Math.max(0, recipientCount - RECIPIENTS.length)} more…</p>';

const newPreview = `{visibleRecipients.map((e) => <p key={e} className="truncate font-mono text-[11px] text-ink-soft">{e}</p>)}
          {!expandedRecipients && mockRecipients.length > 4 && (
            <button type="button" onClick={() => setExpandedRecipients(true)} className="font-mono text-[11px] text-ink-soft hover:text-ink hover:underline">+ {mockRecipients.length - 4} more…</button>
          )}
          {expandedRecipients && mockRecipients.length > 4 && (
             <button type="button" onClick={() => setExpandedRecipients(false)} className="mt-2 font-mono text-[11px] text-ink-soft hover:text-ink hover:underline">Show less</button>
          )}`;

content = content.replace(oldPreview, newPreview);

fs.writeFileSync(filePath, content);
console.log('TeacherQuestionSetup patched for Select All and expanding recipients');
