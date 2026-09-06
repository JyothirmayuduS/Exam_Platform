// ────────────────────────────────────────────────────────────────────────────
// RiskEngine — a decaying 0..100 misconduct score.
//
// Explicitly NOT proof of cheating: it is a triage signal for the proctor
// ("which candidate deserves a look right now?"). Risk grows when independent
// categories confirm and decays back to zero during clean behavior, so a
// single early mistake does not brand a candidate for the whole exam.
// ────────────────────────────────────────────────────────────────────────────

import type { ProctorCategory, RiskLevel, RiskState } from "./types";
import { RISK } from "./config";

const LEVELS = RISK.LEVELS;

export function levelForScore(score: number): RiskLevel {
  const s = Math.max(0, Math.min(RISK.MAX, score));
  if (s <= LEVELS.normal[1]) return "normal";
  if (s <= LEVELS.low[1]) return "low";
  if (s <= LEVELS.high[1]) return "high";
  return "critical";
}

export class RiskEngine {
  private score = 0;
  private lastTick: number;
  private lastIncidentAt = new Map<ProctorCategory, number>();

  /** `initialNow` is injectable so tests can drive a deterministic clock. */
  constructor(initialNow: number = Date.now()) {
    this.lastTick = initialNow;
  }

  /** Current state without advancing the clock. */
  get state(): RiskState {
    return { score: Math.round(this.score), level: levelForScore(this.score) };
  }

  /**
   * Register a confirmed violation of a category. Each category contributes
   * its full weight only once per INCIDENT_WINDOW_MS — repeat confirmations of
   * the same thing (a phone sitting in frame) do NOT stack the score.
   */
  add(category: ProctorCategory, now = Date.now()): RiskState {
    this.advance(now);
    const last = this.lastIncidentAt.get(category) ?? -Infinity;
    if (now - last >= RISK.INCIDENT_WINDOW_MS) {
      this.lastIncidentAt.set(category, now);
      this.score = Math.min(RISK.MAX, this.score + (RISK.WEIGHTS[category] ?? 0));
    }
    return this.state;
  }

  /** Exponential decay toward 0 — call once per second from the loop. */
  advance(now = Date.now()): RiskState {
    if (now > this.lastTick) {
      const dt = now - this.lastTick;
      this.lastTick = now;
      const decay = Math.exp(-RISK.DECAY_PER_MS * dt);
      this.score *= decay;
      if (this.score < 0.5) this.score = 0;
    }
    return this.state;
  }

  reset(): void {
    this.score = 0;
    this.lastTick = Date.now();
    this.lastIncidentAt.clear();
  }
}
