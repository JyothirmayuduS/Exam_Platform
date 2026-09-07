import { describe, expect, it } from "vitest";
import { defaultWatermarkText, renderWatermarkTemplate } from "./watermark";

const ctx = {
  name: "Ravi Teja",
  roll: "221FA12345",
  email: "ravi@vignan.edu",
  examName: "Data Structures Midterm",
  examId: "EXAM-2026-ABCD1234",
  date: new Date("2026-09-08T10:30:00"),
};

describe("renderWatermarkTemplate", () => {
  it("substitutes registration number and name tokens", () => {
    expect(renderWatermarkTemplate("{registration number} {name}", ctx)).toBe("221FA12345 Ravi Teja");
  });

  it("accepts the common 'registraion' typo", () => {
    expect(renderWatermarkTemplate("{registraion number}{name}", ctx)).toBe("221FA12345Ravi Teja");
  });

  it("matches tokens case-insensitively and trims inner whitespace", () => {
    expect(renderWatermarkTemplate("{ NAME } / {ROLL}", ctx)).toBe("Ravi Teja / 221FA12345");
  });

  it("supports roll, usn, email, exam and date tokens", () => {
    expect(renderWatermarkTemplate("{usn}", ctx)).toBe("221FA12345");
    expect(renderWatermarkTemplate("{email}", ctx)).toBe("ravi@vignan.edu");
    expect(renderWatermarkTemplate("{exam}", ctx)).toBe("Data Structures Midterm");
    expect(renderWatermarkTemplate("{exam id}", ctx)).toBe("EXAM-2026-ABCD1234");
    expect(renderWatermarkTemplate("{date}", ctx)).toBe(new Date("2026-09-08T10:30:00").toLocaleDateString());
  });

  it("leaves unknown tokens visible instead of deleting them", () => {
    expect(renderWatermarkTemplate("{hall ticket} {name}", ctx)).toBe("{hall ticket} Ravi Teja");
  });

  it("collapses whitespace left by empty substitutions", () => {
    expect(renderWatermarkTemplate("{name} {email} {roll}", { name: "Ravi Teja", roll: "221FA12345" })).toBe(
      "Ravi Teja 221FA12345",
    );
  });

  it("returns empty string for an empty template", () => {
    expect(renderWatermarkTemplate("", ctx)).toBe("");
    expect(renderWatermarkTemplate("   ", ctx)).toBe("");
  });

  it("passes plain text through unchanged", () => {
    expect(renderWatermarkTemplate("Vignan Internal — do not share", ctx)).toBe("Vignan Internal — do not share");
  });
});

describe("defaultWatermarkText", () => {
  it("renders the classic name · roll fallback", () => {
    expect(defaultWatermarkText({ name: "Ravi Teja", roll: "221FA12345" })).toBe("Ravi Teja · 221FA12345");
  });
});
