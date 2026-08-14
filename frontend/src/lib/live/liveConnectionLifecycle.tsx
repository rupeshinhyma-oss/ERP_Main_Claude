/**
 * Live Connection Lifecycle.
 *
 * Ties the global `liveClient`'s connect/disconnect to the existing
 * `Auth` store (Phase 2 brief section 4):
 *
 *   login  -> establish WebSocket -> (individual pages subscribe to
 *             whatever channels they need via useLiveChannel/useLiveModule)
 *   logout -> disconnect -> clear subscriptions
 *
 * Mounted once, near the root of the app (see `App.tsx`) -- exactly like
 * the existing `NetworkStatusNotifier`, which is the closest existing
 * precedent in this codebase for "a global effect with no visible UI,
 * mounted once at the top of the tree". This component renders nothing;
 * it exists purely for its effect.
 */

import { useEffect } from "react";
import { Auth } from "@/lib/auth";
import { liveClient } from "./liveClient";

export function LiveConnectionLifecycle(): null {
  useEffect(() => {
    // Cover the "already logged in when this mounts" case (e.g. a page
    // refresh with a valid session already in localStorage) in addition
    // to reacting to FUTURE login/logout events below.
    if (Auth.isLoggedIn()) {
      liveClient.connect();
    }

    const unsubscribe = Auth.subscribe((profile) => {
      if (profile) {
        liveClient.connect();
      } else {
        liveClient.disconnect();
      }
    });

    return () => {
      unsubscribe();
      // Intentionally does NOT call liveClient.disconnect() here: this
      // component is mounted once for the app's entire lifetime (see
      // App.tsx), so its cleanup only runs on a real unmount (hot reload
      // in dev, or the app itself tearing down) -- not on every route
      // change, which would otherwise disconnect and reconnect the
      // socket every time the user navigates between pages.
    };
  }, []);

  return null;
}
