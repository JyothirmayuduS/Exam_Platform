import { describe, it, expect } from "vitest";
import { classifyObject, isBenignObject } from "./labels";

describe("classifyObject", () => {
  it("maps every common phone spelling to the phone kind", () => {
    expect(classifyObject("cell phone")).toBe("phone");
    expect(classifyObject("Cell Phone")).toBe("phone");
    expect(classifyObject("mobile phone")).toBe("phone");
    expect(classifyObject("MOBILE PHONE")).toBe("phone");
    expect(classifyObject("phone")).toBe("phone");
  });

  it("maps electronics to their own kinds", () => {
    expect(classifyObject("laptop")).toBe("laptop");
    expect(classifyObject("Laptop")).toBe("laptop");
    expect(classifyObject("tv")).toBe("tv");
    expect(classifyObject("monitor")).toBe("monitor");
  });

  it("returns null for benign objects we must not flag", () => {
    expect(classifyObject("person")).toBeNull();
    expect(classifyObject("book")).toBeNull();
    expect(classifyObject("headphones")).toBeNull();
    expect(classifyObject("bottle")).toBeNull();
    expect(classifyObject("dog")).toBeNull();
  });

  it("keeps related benign objects classified as benign (diagnostics)", () => {
    expect(isBenignObject("person")).toBe(true);
    expect(isBenignObject("headphones")).toBe(true);
    expect(isBenignObject("book")).toBe(true);
    expect(isBenignObject("tv")).toBe(false);
    expect(isBenignObject("cell phone")).toBe(false);
  });
});
