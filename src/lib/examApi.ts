// Public data-access API for the exam platform.
//
// This file is intentionally a thin barrel. All logic now lives in
// `./api/<domain>.ts` — one module per concern (exams, questions, attempts,
// live roster, students, proctoring actions, chat, assignments, grading).
// Shared row-shaping helpers live in `./api/helpers.ts` and stay private;
// shared types live in `./api/types.ts`.
//
// Keep importing from `../lib/examApi` as before — the barrel re-exports
// everything, so page/components code does not need to know the module layout.

export * from "./api/exams";
export * from "./api/questions";
export * from "./api/students";
export * from "./api/attempts";
export * from "./api/live";
export * from "./api/proctoring";
export * from "./api/chat";
export * from "./api/assignments";
export * from "./api/grading";
export * from "./api/teacher";
export * from "./api/audit";
export * from "./api/types";
