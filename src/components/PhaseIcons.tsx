import type { PhaseVisibility } from "../types";

/// The tri-state eye of a Themenbereich or phase: open (all shown), struck
/// through (hidden), half-filled pupil (only some of a group's phases shown).
export function VisibilityEye({ state }: { state: PhaseVisibility }) {
  return (
    <svg className="phases-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      {state === "visible" && <circle cx="12" cy="12" r="3" fill="currentColor" />}
      {state === "partial" && (
        <>
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 9a3 3 0 0 1 0 6z" fill="currentColor" />
        </>
      )}
      {state === "hidden" && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

export function DragHandleIcon() {
  return (
    <svg className="phases-icon" viewBox="0 0 24 24" aria-hidden="true">
      {[8, 16].flatMap((x) => [6, 12, 18].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="currentColor" />))}
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg className="phases-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

export function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg className="phases-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={expanded ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}
