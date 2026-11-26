/// The stand-in for files that belong to no category. An SVG rather than a
/// "*" text glyph: a glyph keeps its font size and reads as a dot, while
/// this scales to whatever box it is placed in (tile, cluster preview,
/// detail view) and fills it.
export default function WildcardIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={"wildcard-icon " + className}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="13" strokeLinecap="round">
        <line x1="50" y1="8" x2="50" y2="92" />
        <line x1="13.6" y1="29" x2="86.4" y2="71" />
        <line x1="13.6" y1="71" x2="86.4" y2="29" />
      </g>
    </svg>
  );
}
