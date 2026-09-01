import * as fs from 'fs';

const filePath = 'src/pages/TeacherProctoring.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add Chat view to view state
if (!content.includes('ProctorChat')) {
  content = content.replace(
    'const [view, setView] = useState<"wall" | "activity">("wall");',
    'const [view, setView] = useState<"wall" | "activity" | "chat">("wall");'
  );

  // 2. Add Export report and Assign Proctors buttons to Header
  const oldHeader = `<span className="border border-alert/30 bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert">● Session live · 00:27:14</span></div>`;
  const newHeader = `<div className="flex items-center gap-3">
      <button className="border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">Assign Proctors</button>
      <button className="border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">Export Report</button>
      <span className="border border-alert/30 bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert">● Session live · 00:27:14</span>
    </div></div>`;
  content = content.replace(oldHeader, newHeader);

  // 3. Add Chat tab
  const oldTabs = `border-transparent text-ink-soft"}`}>Activity</button></div>`;
  const newTabs = `border-transparent text-ink-soft"}`}>Activity</button>
  <button onClick={() => setView("chat")} className={\`border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider \${view === "chat" ? "border-forest text-forest" : "border-transparent text-ink-soft"}\`}>Proctor Chat (2)</button>
  </div>`;
  content = content.replace(oldTabs, newTabs);

  // 4. Update View rendering
  content = content.replace(
    '{view === "wall" ? <VideoWall visible={visible} selected={selected} onSelect={selectCandidate} feedFor={feedFor}/> : <ActivityView visible={visible} selected={selected} onSelect={selectCandidate}/>}',
    '{view === "wall" ? <VideoWall visible={visible} selected={selected} onSelect={selectCandidate} feedFor={feedFor}/> : view === "activity" ? <ActivityView visible={visible} selected={selected} onSelect={selectCandidate}/> : <ProctorChat />}'
  );

  // 5. Add Time Remaining to DEMO_STUDENTS and display it
  content = content.replace(
    'type Student = { name: string; roll: string; status: string; progress: number; violation: string; studentId?: string };',
    'type Student = { name: string; roll: string; status: string; progress: number; violation: string; studentId?: string; timeLeft?: string };'
  );

  content = content.replace(
    /progress: (\d+), violation: "([^"]*)" /g,
    'progress: $1, violation: "$2", timeLeft: "18m" '
  );
  // Actually, DEMO_STUDENTS might be formatted differently, let's just replace the type and then the display logic.
  
  // Update VideoWall to show time left
  content = content.replace(
    '{student.status} · {student.progress}%</span></div><div className="p-2">',
    '{student.status} · {student.progress}% · {student.timeLeft || "18m"} left</span></div><div className="p-2">'
  );

  // Update Selected Candidate view to show time left
  content = content.replace(
    '{selected.status} · {selected.progress}% complete</p>',
    '{selected.status} · {selected.progress}% complete · {selected.timeLeft || "18m"} remaining</p>'
  );

  // 6. Add ProctorChat component at the bottom
  const chatComponent = `
function ProctorChat() {
  return (
    <section className="mt-6 border border-line bg-paper p-5 sm:p-6 h-[400px] flex flex-col">
      <div className="border-b border-line pb-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Team communication</p>
        <h2 className="mt-1 font-serif text-xl font-semibold">Proctor Chat</h2>
      </div>
      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        <div className="flex gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-forest text-paper text-[12px]">KV</span>
          <div>
            <p className="text-[12px] font-medium">Dr. K. Venkatesh <span className="ml-2 font-mono text-[9px] text-ink-soft">10:15 AM</span></p>
            <p className="mt-1 text-[13px]">Can someone keep an eye on Hall B? Seeing a lot of gaze warnings.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-line-strong text-ink text-[12px]">TA</span>
          <div>
            <p className="text-[12px] font-medium">T. Arvind (TA) <span className="ml-2 font-mono text-[9px] text-ink-soft">10:17 AM</span></p>
            <p className="mt-1 text-[13px]">On it. I'll focus on the flagged feeds.</p>
          </div>
        </div>
      </div>
      <div className="border-t border-line pt-4 flex gap-3">
        <input placeholder="Message proctors..." className="flex-1 border border-line-strong bg-paper-raised px-3 py-2 text-[13px] outline-none focus:border-forest" />
        <button className="border border-forest bg-forest px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">Send</button>
      </div>
    </section>
  );
}
`;
  content += chatComponent;

  fs.writeFileSync(filePath, content);
  console.log('TeacherProctoring patched with missing Live Monitoring features');
} else {
  console.log('Already patched');
}
