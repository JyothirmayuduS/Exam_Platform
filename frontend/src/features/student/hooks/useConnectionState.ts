import { useEffect, useRef, useState } from "react";
import {
  classifyConnection,
  settleConnection,
  type ConnectionSignals,
  type ConnectionState,
  type SettledConnection,
} from "@/shared/services/lowBandwidth";

type NetworkInformation = {
  effectiveType?: string;
  rtt?: number;
  downlink?: number;
  saveData?: boolean;
  addEventListener?: (type: "change", cb: () => void) => void;
  removeEventListener?: (type: "change", cb: () => void) => void;
};

function readNetwork(): Pick<ConnectionSignals, "effectiveType" | "rttMs" | "downlinkMbps" | "saveData"> {
  const c = (typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: NetworkInformation }).connection : undefined);
  if (!c) return {};
  return { effectiveType: c.effectiveType ?? null, rttMs: c.rtt ?? null, downlinkMbps: c.downlink ?? null, saveData: c.saveData ?? null };
}

/**
 * Good / weak / lost for the exam screen. Lost comes from the existing
 * connection-lost rule (offline or failing saves); weak from LiveKit's link
 * quality and the browser's network estimate. Recovery to good is delayed so
 * low-bandwidth mode does not switch on and off every few seconds.
 */
export default function useConnectionState(connectionLost: boolean, videoQuality: ConnectionSignals["videoQuality"]): ConnectionState {
  const [network, setNetwork] = useState(readNetwork);
  useEffect(() => {
    const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (!c?.addEventListener) return;
    const onChange = () => setNetwork(readNetwork());
    c.addEventListener("change", onChange);
    return () => c.removeEventListener?.("change", onChange);
  }, []);

  const raw = classifyConnection({ online: true, savesFailing: connectionLost, videoQuality, ...network });
  const settled = useRef<SettledConnection>({ state: raw, goodSince: null });
  const [state, setState] = useState<ConnectionState>(raw);

  useEffect(() => {
    const step = () => {
      settled.current = settleConnection(settled.current, raw, Date.now());
      setState(settled.current.state);
    };
    step();
    if (raw !== "good" || settled.current.state === "good") return;
    const id = window.setInterval(step, 5_000);
    return () => window.clearInterval(id);
  }, [raw]);

  return state;
}
