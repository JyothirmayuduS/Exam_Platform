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
} from "@/features/proctoring/domain/types";

export * as PROCTOR_CONFIG from "@/features/proctoring/domain/config";
export { CADENCE, PHONE_ACK_MS, GAZE, FACE, OBJECT, TRACKING, AUDIO, COOLDOWN_MS, RISK, EVIDENCE } from "@/features/proctoring/domain/config";
export { classifyObject, kindName, isBenignObject } from "@/features/proctoring/domain/labels";
export { iou, centerDistance, lowerRegion, insideRoi, ema } from "@/features/proctoring/domain/geometry";
export { ObjectTracker } from "@/features/proctoring/domain/ObjectTracker";
export { decideObjectEvent, gazeLabel, FUSION_LABELS } from "@/features/proctoring/domain/fusion";
export type { GazeFusionState, FusionOutcome } from "@/features/proctoring/domain/fusion";
export { RiskEngine, levelForScore } from "@/features/proctoring/domain/risk";
export { ViolationGate, severityFor } from "@/features/proctoring/domain/violations";
export { proctorDiag, pushObjectSample } from "@/features/proctoring/domain/diag";
export type { DiagSnapshot } from "@/features/proctoring/domain/diag";
