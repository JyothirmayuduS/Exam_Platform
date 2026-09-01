// Single source of truth for the live exam session roster.
// Submissions (live tracking) and Evaluate (grading) both read from here so the
// two pages never disagree about who wrote which exam.

export type Severity = "critical" | "notice";
export type Flag = { severity: Severity; label: string; at: string };
export type AttemptState = "Submitted" | "In progress" | "Not started";
export type Network = "Stable" | "Reconnected" | "Unstable" | "Offline";

export type Attempt = {
  id: string;
  name: string;
  roll: string;
  initials: string;
  exam: string;
  state: AttemptState;
  answered: number;
  total: number;
  startedAt: string;
  submittedAgo: string;
  minutesUsed: number;
  lastActivity: string;
  device: string;
  network: Network;
  autoSaveAt: string;
  flags: Flag[];
};

export const LIVE_EXAM = "Data Structures & Algorithms";
export const SESSION_MINUTES = 45;

export const ATTEMPTS: Attempt[] = [
  { id: "A-031", name: "M. Sai Charan", roll: "21VGN0163", initials: "SC", exam: LIVE_EXAM, state: "Submitted", answered: 7, total: 7,
    startedAt: "10:00 AM", submittedAgo: "12 min ago", minutesUsed: 33, lastActivity: "Submitted 10:33 AM", device: "Chrome · Windows", network: "Stable", autoSaveAt: "10:33 AM", flags: [] },
  { id: "A-032", name: "K. Rohan Teja", roll: "21VGN0158", initials: "RT", exam: LIVE_EXAM, state: "Submitted", answered: 7, total: 7,
    startedAt: "10:00 AM", submittedAgo: "18 min ago", minutesUsed: 27, lastActivity: "Submitted 10:27 AM", device: "Chrome · Windows", network: "Stable", autoSaveAt: "10:27 AM",
    flags: [{ severity: "critical", label: "Second face detected in frame", at: "at 00:24:10" }, { severity: "notice", label: "Gaze off-screen for 8 seconds", at: "at 00:19:02" }] },
  { id: "A-033", name: "A. Deepika Reddy", roll: "21VGN0171", initials: "DR", exam: LIVE_EXAM, state: "Submitted", answered: 7, total: 7,
    startedAt: "10:01 AM", submittedAgo: "24 min ago", minutesUsed: 20, lastActivity: "Submitted 10:21 AM", device: "Edge · Windows", network: "Reconnected", autoSaveAt: "10:21 AM", flags: [] },
  { id: "A-034", name: "P. Meghana", roll: "21VGN0217", initials: "PM", exam: LIVE_EXAM, state: "Submitted", answered: 7, total: 7,
    startedAt: "10:00 AM", submittedAgo: "31 min ago", minutesUsed: 14, lastActivity: "Submitted 10:14 AM", device: "Chrome · macOS", network: "Stable", autoSaveAt: "10:14 AM",
    flags: [{ severity: "critical", label: "Prohibited software detected: AnyDesk", at: "at 00:12:44" }] },
  { id: "A-035", name: "B. Priya Nikitha", roll: "21VGN0142", initials: "PN", exam: LIVE_EXAM, state: "Submitted", answered: 7, total: 7,
    startedAt: "10:02 AM", submittedAgo: "3 min ago", minutesUsed: 40, lastActivity: "Submitted 10:42 AM", device: "Chrome · Windows", network: "Stable", autoSaveAt: "10:42 AM", flags: [] },
  { id: "A-036", name: "L. Sneha", roll: "21VGN0221", initials: "LS", exam: LIVE_EXAM, state: "In progress", answered: 6, total: 7,
    startedAt: "10:01 AM", submittedAgo: "", minutesUsed: 41, lastActivity: "Active now · Question 7", device: "Chrome · Windows", network: "Stable", autoSaveAt: "1 min ago", flags: [] },
  { id: "A-037", name: "G. Anusha", roll: "21VGN0196", initials: "GA", exam: LIVE_EXAM, state: "In progress", answered: 5, total: 7,
    startedAt: "10:00 AM", submittedAgo: "", minutesUsed: 42, lastActivity: "Active now · Question 6", device: "Firefox · Ubuntu", network: "Stable", autoSaveAt: "40 sec ago", flags: [] },
  { id: "A-038", name: "R. Kiran Kumar", roll: "21VGN0209", initials: "KK", exam: LIVE_EXAM, state: "In progress", answered: 3, total: 7,
    startedAt: "10:06 AM", submittedAgo: "", minutesUsed: 36, lastActivity: "Reconnected 4 min ago", device: "Chrome · Android", network: "Reconnected", autoSaveAt: "4 min ago",
    flags: [{ severity: "notice", label: "Tab switch detected", at: "at 00:31:52" }] },
  { id: "A-039", name: "D. Arjun Rao", roll: "21VGN0233", initials: "AR", exam: LIVE_EXAM, state: "In progress", answered: 1, total: 7,
    startedAt: "10:04 AM", submittedAgo: "", minutesUsed: 38, lastActivity: "No heartbeat for 6 min", device: "Chrome · Windows", network: "Offline", autoSaveAt: "6 min ago",
    flags: [{ severity: "critical", label: "Camera feed lost", at: "at 00:36:20" }] },
  { id: "A-040", name: "S. Vamsi Krishna", roll: "21VGN0184", initials: "VK", exam: LIVE_EXAM, state: "Not started", answered: 0, total: 7,
    startedAt: "—", submittedAgo: "", minutesUsed: 0, lastActivity: "Never signed in", device: "No device check", network: "Offline", autoSaveAt: "—", flags: [] },
  { id: "B-018", name: "N. Harika Sree", roll: "21VGN0191", initials: "HS", exam: "Database Management Systems", state: "Submitted", answered: 4, total: 4,
    startedAt: "09:00 AM", submittedAgo: "9 min ago", minutesUsed: 36, lastActivity: "Submitted 09:36 AM", device: "Chrome · Windows", network: "Stable", autoSaveAt: "09:36 AM", flags: [] },
  { id: "B-019", name: "T. Yashwanth", roll: "21VGN0203", initials: "TY", exam: "Database Management Systems", state: "Submitted", answered: 4, total: 4,
    startedAt: "09:00 AM", submittedAgo: "27 min ago", minutesUsed: 18, lastActivity: "Submitted 09:18 AM", device: "Safari · macOS", network: "Stable", autoSaveAt: "09:18 AM", flags: [] },
];

export const submittedAttempts = () => ATTEMPTS.filter((a) => a.state === "Submitted");
export const attemptById = (id: string) => ATTEMPTS.find((a) => a.id === id) ?? null;
export const needsAttention = (a: Attempt) => a.flags.length > 0 || a.network === "Offline";
export const evaluationPath = (id: string) => `/teacher/evaluate?review=${id}`;
