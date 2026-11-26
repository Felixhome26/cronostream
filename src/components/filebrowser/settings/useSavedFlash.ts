import { useCallback, useEffect, useRef, useState } from "react";

/// A flag that turns on for a moment — the "Gespeichert" confirmation for
/// settings that are committed on blur or Enter instead of on every click.
export function useSavedFlash(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}
