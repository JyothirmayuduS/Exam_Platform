import { NumberField } from "@/shared/components/ui";
import {
  KIND_LABEL,
  NEGATIVE_KINDS,
  describeNegative,
  penaltyFor,
  splitMinutes,
  type NegativeMode,
  type QuestionKind,
  type SectionSummary,
} from "@/shared/domain/exam";

const fieldCls = "mt-1 block w-24 border border-line bg-paper px-3 py-2 text-[13px] outline-none focus:border-forest";
const segCls = (on: boolean) =>
  `border px-3 py-2 text-[12px] transition ${on ? "border-forest bg-forest text-paper" : "border-line text-ink hover:border-forest"}`;

const FRACTIONS: { value: number; label: string }[] = [
  { value: 0.25, label: "¼" },
  { value: 0.33, label: "⅓" },
  { value: 0.5, label: "½" },
  { value: 1, label: "Full" },
];

export type NegativeValue = {
  negativeMode: NegativeMode;
  negativeMarks: number;
  negativeFraction: number;
  negativeKinds: QuestionKind[];
};

/** Amount, mode and scope of the penalty, with a worked example. */
export function NegativeMarkingFields({ value, onChange }: {
  value: NegativeValue;
  onChange: (patch: Partial<NegativeValue>) => void;
}) {
  const settings = { negative: true, ...value };
  const toggleKind = (k: QuestionKind) =>
    onChange({ negativeKinds: value.negativeKinds.includes(k) ? value.negativeKinds.filter((x) => x !== k) : [...value.negativeKinds, k] });
  const rule = describeNegative(settings);
  const examplePenalty = penaltyFor(value.negativeKinds[0] ?? "mcq", 2, settings);

  return (
    <div className="mt-3 space-y-4 border-l-2 border-forest bg-raised/60 px-4 py-4">
      <div>
        <p className="text-[12px] font-medium">Deduct per wrong answer</p>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Deduction type">
          <button type="button" role="radio" aria-checked={value.negativeMode === "fraction"} onClick={() => onChange({ negativeMode: "fraction" })} className={segCls(value.negativeMode === "fraction")}>Share of question marks</button>
          <button type="button" role="radio" aria-checked={value.negativeMode === "fixed"} onClick={() => onChange({ negativeMode: "fixed" })} className={segCls(value.negativeMode === "fixed")}>Fixed marks</button>
        </div>
        {value.negativeMode === "fraction" ? (
          <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Share of marks">
            {FRACTIONS.map((f) => (
              <button key={f.value} type="button" role="radio" aria-checked={value.negativeFraction === f.value} onClick={() => onChange({ negativeFraction: f.value })} className={`${segCls(value.negativeFraction === f.value)} min-w-[52px] font-mono`}>{f.label}</button>
            ))}
          </div>
        ) : (
          <label className="mt-3 block text-[12px] text-soft">Marks deducted
            <NumberField value={value.negativeMarks} onChange={(n) => onChange({ negativeMarks: n })} min={0.25} max={100} step={0.25} inputMode="decimal" fallback={1} aria-label="Marks deducted per wrong answer" className={fieldCls} />
          </label>
        )}
      </div>

      <div>
        <p className="text-[12px] font-medium">Applies to</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {NEGATIVE_KINDS.map((k) => {
            const on = value.negativeKinds.includes(k);
            return (
              <label key={k} className={`flex cursor-pointer items-center gap-2 border px-3 py-1.5 text-[12px] ${on ? "border-forest" : "border-line text-soft"}`}>
                <input type="checkbox" checked={on} onChange={() => toggleKind(k)} className="h-3.5 w-3.5 accent-forest" />
                {KIND_LABEL[k]}
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-soft">Descriptive and coding answers are graded by hand and never penalised.</p>
      </div>

      {rule ? (
        <div className="border border-line bg-paper px-3 py-2.5 text-[12px] leading-relaxed">
          <p>{rule}</p>
          <p className="mt-1 text-soft">Example, 2-mark {KIND_LABEL[value.negativeKinds[0] ?? "mcq"]}: correct +2 · wrong −{examplePenalty} · skipped 0. A paper total never goes below 0.</p>
        </div>
      ) : (
        <p className="border border-amber/40 bg-amber/5 px-3 py-2.5 text-[12px] text-amber">Pick at least one question type, or nothing will be deducted.</p>
      )}
    </div>
  );
}

/** Sections the current pool produces, so "Enable sections" shows its effect. */
export function SectionList({ sections }: { sections: SectionSummary[] }) {
  if (sections.length === 0) {
    return <p className="mt-2 text-[11px] text-soft">Add questions to the pool to see the sections.</p>;
  }
  return (
    <ol className="mt-3 divide-y divide-line border border-line">
      {sections.map((sec, i) => (
        <li key={sec.name} className="flex items-center gap-3 px-3 py-2 text-[12px]">
          <span className="font-mono text-[10px] text-soft">{i + 1}</span>
          <span className="flex-1 font-medium">{sec.name}</span>
          <span className="font-mono text-[11px] text-soft">{sec.count} q · {sec.marks} marks</span>
        </li>
      ))}
    </ol>
  );
}

/** Minutes per section, checked against the exam duration. */
export function SectionTimingFields({ sections, minutes, duration, onChange }: {
  sections: SectionSummary[];
  minutes: Record<string, number>;
  duration: number;
  onChange: (next: Record<string, number>) => void;
}) {
  if (sections.length === 0) return null;
  const total = sections.reduce((t, sec) => t + (Number(minutes[sec.name]) || 0), 0);
  const unset = sections.filter((sec) => !(Number(minutes[sec.name]) > 0));
  const over = total > duration;
  const under = unset.length === 0 && total < duration;

  return (
    <div className="mt-3 space-y-3 border-l-2 border-forest bg-raised/60 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium">Minutes per section</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => onChange(splitMinutes(sections, duration, "even"))} className="border border-line px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-soft hover:border-forest hover:text-forest">Split evenly</button>
          <button type="button" onClick={() => onChange(splitMinutes(sections, duration, "marks"))} className="border border-line px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-soft hover:border-forest hover:text-forest">Split by marks</button>
        </div>
      </div>
      <div className="divide-y divide-line border border-line bg-paper">
        {sections.map((sec) => (
          <label key={sec.name} className="flex items-center gap-3 px-3 py-2 text-[12px]">
            <span className="flex-1">
              <span className="block font-medium">{sec.name}</span>
              <span className="font-mono text-[10px] text-soft">{sec.count} q · {sec.marks} marks</span>
            </span>
            <NumberField
              value={Number(minutes[sec.name]) || 0}
              onChange={(n) => onChange({ ...minutes, [sec.name]: n })}
              min={0}
              max={600}
              fallback={0}
              aria-label={`Minutes for ${sec.name}`}
              className="w-20 border border-line bg-paper px-2 py-1.5 text-right text-[13px] outline-none focus:border-forest"
            />
            <span className="w-8 text-soft">min</span>
          </label>
        ))}
      </div>
      <p className={`text-[12px] ${over ? "text-alert" : "text-soft"}`}>
        Total <b className="tabular">{total}</b> of {duration} min.
        {over && " The overall exam timer ends first, so later sections get cut short. Reduce the minutes or raise the duration."}
        {under && ` ${duration - total} min of the exam duration will be unused.`}
        {unset.length > 0 && ` Sections at 0 share the remaining ${Math.max(0, duration - total)} min.`}
      </p>
    </div>
  );
}
