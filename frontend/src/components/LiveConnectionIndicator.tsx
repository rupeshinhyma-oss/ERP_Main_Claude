/**
 * LiveConnectionIndicator -- small, non-intrusive WebSocket status badge.
 *
 * Deliberately separate from the existing `NetworkStatusNotifier`
 * (browser online/offline, via `navigator.onLine`) -- the two signals are
 * genuinely different: a laptop can be online while this tab's WebSocket
 * is still mid-reconnect (e.g. right after the backend restarts), and
 * conversely a dropped WebSocket is not the same event as losing internet
 * entirely. Reusing `NetworkStatusNotifier`'s own state for this would
 * conflate two different failure modes into one indicator.
 *
 * Renders nothing at all while `connected` -- Phase 2 brief section 6:
 * "Do not add intrusive UI. The application should still function
 * normally when disconnected." Only appears for `reconnecting`/`error`,
 * and only after a short delay (see `SHOW_DELAY_MS`) so a normal,
 * sub-second reconnect blip never flashes anything on screen at all.
 */

import { useEffect, useState } from "react";
import { useLiveConnectionStatus } from "@/lib/live/useLive";

const SHOW_DELAY_MS = 4000;

export function LiveConnectionIndicator() {
  const status = useLiveConnectionStatus();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status === "reconnecting" || status === "error") {
      const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [status]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        left: "24px",
        zIndex: 99998,
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 16px",
        borderRadius: "10px",
        background: "#0F172A",
        color: "#ffffff",
        boxShadow: "0 10px 25px rgba(15, 23, 42, 0.35)",
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: "13px",
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: "#FBBF24",
          flexShrink: 0,
          animation: "livePulse 1.4s ease-in-out infinite",
        }}
      />
      <style>{`
        @keyframes livePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
      Reconnecting live updates…
    </div>
  );
}
