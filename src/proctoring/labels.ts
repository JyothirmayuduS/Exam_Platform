// ────────────────────────────────────────────────────────────────────────────
// Model-label normalization.
//
// The object detector returns COCO-style labels whose exact spelling varies by
// model checkpoint ("cell phone", "mobile phone", "phone", …). Rather than
// hard-coding one string in the detection loop (a wrong guess silently kills
// phone detection — the classic "never detects" bug), every raw label is
// classified through this single mapping layer, and unknown labels are
// surfaced for diagnostics instead of being silently dropped.
// ────────────────────────────────────────────────────────────────────────────

import type { ObjectKind } from "./types";

const PHONE_HINTS = [
  "cell phone", "mobile phone", "phone", "telephone", "smartphone", "smart phone",
  "remote", "tablet", "mobile", "handset", "iphone", "android"
];
const LAPTOP_HINTS = ["laptop", "notebook"];
const TV_HINTS = ["tv", "television"];
const MONITOR_HINTS = ["monitor", "display"];

// Word-boundary matching: "headphones" contains the substring "phone" but is
// NOT a phone — naive `includes()` matching would flag every candidate wearing
// earbuds. \b keeps "cell phone"/"mobile phone" matching while rejecting
// compounds like "headphones"/"telephone".
function hasAny(label: string, hints: readonly string[]): boolean {
  for (const h of hints) {
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(label)) return true;
  }
  return false;
}

/**
 * Map a raw detector label to a normalized kind. Returns null when the label
 * is not something we act on (headphones, person, book, …) — those are
 * deliberately NOT violations by themselves.
 */
export function classifyObject(rawLabel: string): ObjectKind | null {
  const label = rawLabel.toLowerCase();
  if (hasAny(label, PHONE_HINTS)) return "phone";
  if (hasAny(label, LAPTOP_HINTS)) return "laptop";
  if (hasAny(label, TV_HINTS)) return "tv";
  if (hasAny(label, MONITOR_HINTS)) return "monitor";
  return null;
}

/** Human name of a kind, for diagnostics / report lines. */
export function kindName(kind: ObjectKind): string {
  switch (kind) {
    case "phone": return "phone";
    case "laptop": return "laptop";
    case "tv": return "TV";
    case "monitor": return "monitor";
  }
}

/** Diagnostics helper — is this a known non-target class we deliberately drop? */
export function isBenignObject(rawLabel: string): boolean {
  const label = rawLabel.toLowerCase();
  return (
    hasAny(label, ["person", "headphone", "headphones", "earbud", "earbuds", "book", "cup", "bottle", "chair", "backpack"]) ||
    label === "remote"
  );
}
