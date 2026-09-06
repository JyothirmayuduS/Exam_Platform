// Proctor AI engine — public surface.
//
// Component code imports from here (or the specific module); the engine never
// imports React or ProctorAI, so every module is unit-testable in isolation.
export type {
  ProctorCategory,
  BBox,
  ObjectKind,
  Detection,
  TrackedObject,
  ProctorSeverity,
  ProctorViolation,
  RiskLevel,
  RiskState,
} from "./types";

export * as PROCTOR_CONFIG from "./config";
export { CADENCE, PHONE_ACK_MS, GAZE, FACE, OBJECT, TRACKING, AUDIO, COOLDOWN_MS, RISK, EVIDENCE } from "./config";
export { classifyObject, kindName, isBenignObject } from "./labels";
export { iou, centerDistance, lowerRegion, insideRoi, ema } from "./geometry";
export { ObjectTracker } from "./ObjectTracker";
export { decideObjectEvent, gazeLabel, FUSION_LABELS } from "./fusion";
export type { GazeFusionState, FusionOutcome } from "./fusion";
export { RiskEngine, levelForScore } from "./risk";
export { ViolationGate, severityFor } from "./violations";
export { proctorDiag, pushObjectSample } from "./diag";
export type { DiagSnapshot } from "./diag";
