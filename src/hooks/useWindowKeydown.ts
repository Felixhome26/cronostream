import { useEffect, useLayoutEffect, useRef } from "react";

/// One window-level keydown listener that always calls the latest `handler`.
///
/// A component that subscribed a separate listener per shortcut, each
/// re-subscribed through its own effect dependencies, ran every shortcut
/// against whatever it had captured at its last subscription — values left
/// out of the dependencies went stale. Here the listener is subscribed once
/// and the handler is swapped after every render, so it always sees the
/// state that is on screen.
export function useWindowKeydown(handler: (ev: KeyboardEvent) => void) {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const listener = (ev: KeyboardEvent) => handlerRef.current(ev);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
