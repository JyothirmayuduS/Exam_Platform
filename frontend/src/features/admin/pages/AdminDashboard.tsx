import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import RoleLayout from "@/shared/components/RoleLayout";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import { loadAdminOverview, type AdminOverview } from "@/shared/data/api/admin";
import { PageHeading, Button } from "@/features/teacher/components/PageChrome";
import { ago } from "@/features/admin/components/AdminUI";
import AdminLive from "@/features/admin/pages/AdminLive";
import AdminResults from "@/features/admin/pages/AdminResults";
import AdminMoodle from "@/features/admin/pages/AdminMoodle";
import AdminAccounts from "@/features/admin/pages/AdminAccounts";
import AdminData from "@/features/admin/pages/AdminData";
import AdminSystem from "@/features/admin/pages/AdminSystem";
import AdminAudit from "@/features/admin/pages/AdminAudit";

const SECTIONS: Record<string, { title: string; detail: string }> = {
  overview: { title: "Today", detail: "Live sittings, connections, flags and what the next sittings still need." },
  results: { title: "Marking & results", detail: "Answers waiting to be marked, flags waiting for review, unreleased results, holds and the ERP export." },
  moodle: { title: "Moodle", detail: "Grades that failed to reach Moodle, students waiting for confirmation, and the retry job." },
  accounts: { title: "Students & devices", detail: "Accounts without a role, registration photos and exam browser versions." },
  storage: { title: "Storage & data", detail: "Evidence storage per exam, what is due for deletion, holds and backups." },
  system: { title: "System", detail: "Health of the site and services, the latest exam browser and scheduled jobs." },
  audit: { title: "Audit log", detail: "Every recorded action, filterable by person and exam." },
};

const REFRESH_MS = 30_000;

export default function AdminDashboard() {
  const location = useLocation();
  const section = location.pathname.split("/").filter(Boolean)[1] || "overview";
  const { profile } = useCurrentProfile();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);

  const notify = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await loadAdminOverview();
    setLoading(false);
    if (res.ok) { setData(res.data); setError(null); } else setError(res.error);
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const d = data;
  const writing = d?.live.filter((l) => l.counts.writing + l.counts.disconnected + l.counts.paused > 0).length ?? 0;
  const nav = [
    { label: "Today", to: "/admin", end: true, badge: writing ? `${writing} live` : undefined },
    { label: "Marking & results", to: "/admin/results", badge: d ? String(d.marking.reduce((t, m) => t + m.waiting, 0) + d.flagsWaitingTotal) : undefined },
    { label: "Moodle", to: "/admin/moodle", badge: d?.moodle.failed.length ? String(d.moodle.failed.length) : undefined },
    { label: "Students & devices", to: "/admin/accounts" },
    { label: "Storage & data", to: "/admin/storage" },
    { label: "System", to: "/admin/system" },
    { label: "Audit log", to: "/admin/audit" },
    { label: "Teacher console", to: "/teacher" },
  ];
  const meta = SECTIONS[section] ?? SECTIONS.overview;

  return (
    <>
      <RoleLayout role="Admin" name={profile?.full_name ?? "Administrator"} subtitle={profileSubtitle(profile)} tone="#7A2E2E" items={nav} status={d ? `Updated ${ago(d.generatedAt)}` : "Loading…"}>
        <PageHeading
          eyebrow="Admin console"
          title={meta.title}
          detail={meta.detail}
          action={<Button onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>}
        />
        {error && <p role="alert" className="mt-6 border-l-2 border-alert bg-alert/5 px-4 py-3 text-[13px] text-alert">{error}</p>}
        {!d && !error && <p className="mt-10 text-center font-mono text-[11px] uppercase tracking-widest text-soft">Loading the console…</p>}
        {d && (
          <div className="mt-6 space-y-6">
            {section === "overview" && <AdminLive data={d} />}
            {section === "results" && <AdminResults data={d} notify={notify} onChanged={refresh} />}
            {section === "moodle" && <AdminMoodle data={d} notify={notify} onChanged={refresh} />}
            {section === "accounts" && <AdminAccounts data={d} />}
            {section === "storage" && <AdminData data={d} />}
            {section === "system" && <AdminSystem />}
            {section === "audit" && <AdminAudit data={d} />}
          </div>
        )}
      </RoleLayout>
      <div className="pointer-events-none fixed right-6 top-6 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto border-l-2 border-forest bg-paper px-4 py-3 shadow-xl">
            <p className="font-serif text-[14px] text-ink">{t.msg}</p>
          </div>
        ))}
      </div>
    </>
  );
}
