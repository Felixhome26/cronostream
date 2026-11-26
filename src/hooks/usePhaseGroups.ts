import { useCallback, useEffect, useState } from "react";
import { invoke } from "../busy";
import type { PhaseGroupView } from "../types";
import { todayDay } from "../utils/phases";

/// The stream's Themenbereiche with their phases, top to bottom.
///
/// Loaded once per opened project and again whenever `reloadKey` changes —
/// pass the shell's `refreshToken`, so an undo in the Protokoll shows up.
/// Each load also moves the end of "läuft noch" phases to today (done by
/// the backend, unlogged). So that a stream left open over midnight (or
/// a sleeping laptop) follows the date change too, it reloads when the day
/// turns and when the window comes back to the front on a new day.
///
/// The management dialog edits through `setGroups`; the timeline reads
/// `groups` and draws the phases whose `visible` is on.
export function usePhaseGroups(reloadKey: number = 0) {
  const [groups, setGroups] = useState<PhaseGroupView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      setGroups(await invoke<PhaseGroupView[]>("list_phase_groups"));
    } catch {
      // Keep what is shown — the list is only ever stale, never wrong.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  useEffect(() => {
    let day = todayDay();
    let timer: number | undefined;
    const reloadIfNewDay = () => {
      if (todayDay() === day) return;
      day = todayDay();
      void reload();
    };
    // A timer sleeps through a suspended machine, hence the second trigger.
    const armTimer = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      timer = window.setTimeout(() => {
        reloadIfNewDay();
        armTimer();
      }, nextMidnight - now.getTime() + 1000);
    };
    armTimer();
    window.addEventListener("focus", reloadIfNewDay);
    document.addEventListener("visibilitychange", reloadIfNewDay);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", reloadIfNewDay);
      document.removeEventListener("visibilitychange", reloadIfNewDay);
    };
  }, [reload]);

  return { groups, setGroups, reload, loaded };
}
