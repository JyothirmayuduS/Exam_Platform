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

export * from "@/shared/data/api/exams";
export * from "@/shared/data/api/questions";
export * from "@/shared/data/api/students";
export * from "@/shared/data/api/attempts";
export * from "@/shared/data/api/live";
export * from "@/shared/data/api/proctoring";
export * from "@/shared/data/api/chat";
export * from "@/shared/data/api/assignments";
export * from "@/shared/data/api/grading";
export * from "@/shared/data/api/teacher";
export * from "@/shared/data/api/audit";
export * from "@/shared/data/api/types";
