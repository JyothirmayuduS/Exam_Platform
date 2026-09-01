import { useEffect, useState } from "react";

export default function OfflineIndicator() {
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);

  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => setIsOffline(false);

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[100] bg-alert text-paper px-4 py-2 text-center text-[12px] font-mono tracking-widest uppercase shadow-md flex items-center justify-center gap-2">
      <span className="h-2 w-2 bg-paper animate-pulse shrink-0" />
      <span className="truncate">You are offline. Your progress is being saved locally.</span>
    </div>
  );
}
