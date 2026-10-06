import { describe, expect, it } from "vitest";
import { byNewest, examPhase, matchesPhase } from "@/shared/domain/exam/phase";

const now = Date.parse("2026-10-05T10:00:00Z");
const at = (mins: number) => new Date(now + mins * 60_000).toISOString();

describe("examPhase", () => {
  it("classifies drafts, upcoming, live and finished exams", () => {
    expect(examPhase({ status: "draft", scheduled_at: at(-5), duration_minutes: 60 }, now)).toBe("draft");
    expect(examPhase({ status: "published", scheduled_at: at(30), duration_minutes: 60 }, now)).toBe("upcoming");
    expect(examPhase({ status: "scheduled", scheduled_at: at(-10), duration_minutes: 60 }, now)).toBe("live");
    expect(examPhase({ status: "published", scheduled_at: at(-120), duration_minutes: 60 }, now)).toBe("completed");
    expect(examPhase({ status: "published", scheduled_at: null }, now)).toBe("live");
    expect(examPhase({ status: "scheduled", scheduled_at: null }, now)).toBe("upcoming");
  });

  it("filters by phase", () => {
    expect(matchesPhase({ status: "draft" }, "draft", now)).toBe(true);
    expect(matchesPhase({ status: "draft" }, "live", now)).toBe(false);
    expect(matchesPhase({ status: "draft" }, "all", now)).toBe(true);
  });

  it("sorts newest created first", () => {
    const list = [{ id: "a", created_at: at(-60) }, { id: "b", created_at: at(-1) }, { id: "c" }];
    expect(list.sort(byNewest).map((e) => e.id)).toEqual(["b", "a", "c"]);
  });
});
