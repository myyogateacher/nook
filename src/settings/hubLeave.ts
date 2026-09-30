// The Settings hub's in-app leave hook (Wave 37 review L1). A section holding something a move would
// lose without asking (Team → Policies with unsaved changes) registers a hook; the hub runs it before
// its own moves (the nav, the phone back arrow, Home, Bin, Inbox, the bell, sign-out). Browser Back
// and Forward are the section's own history guard's job, as before.
import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Runs before an in-app move away from the section on screen. Returns true when it took the move:
 * it asks first, and calls `leave` once the person chose to leave (or never, to stay).
 */
export type BeforeHubLeave = (leave: () => void) => boolean;

/** Registers the section's hook with the hub; returns the unregister function. Null outside the hub. */
export const HubBeforeLeaveContext = createContext<((hook: BeforeHubLeave) => () => void) | null>(null);

/** Registers `hook` (read fresh on every call) with the hub while mounted. */
export function useBeforeHubLeave(hook: BeforeHubLeave) {
  const register = useContext(HubBeforeLeaveContext);
  const hookRef = useRef(hook);
  hookRef.current = hook;
  useEffect(() => register ? register((leave) => hookRef.current(leave)) : undefined, [register]);
}
