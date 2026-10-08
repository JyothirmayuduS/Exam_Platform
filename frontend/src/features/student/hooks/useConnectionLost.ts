import { useEffect, useState } from "react";

/**
 * True while the exam cannot reach the server: the browser reports offline,
 * or saves keep failing (Wi-Fi up but no internet, captive portal).
 */
export default function useConnectionLost(saveFailures: number, failureThreshold = 2): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return !online || saveFailures >= failureThreshold;
}
