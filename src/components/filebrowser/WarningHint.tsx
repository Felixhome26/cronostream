interface Props {
  text: string;
}

/// Red triangle-with-exclamation badge. Uses a CSS-only tooltip (`::after`
/// driven by `data-tooltip`) rather than the native `title` attribute,
/// since the browser's built-in tooltip has its own (OS-controlled, not
/// stylable) hover delay — this one shows the instant the pointer is over
/// the icon, which matters for a warning the user should see immediately.
export default function WarningHint({ text }: Props) {
  return (
    <span className="warning-hint" data-tooltip={text} aria-label={text} tabIndex={0}>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 3.5 L22 20.5 H2 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <line x1="12" y1="9.5" x2="12" y2="14.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17.5" r="1.1" fill="currentColor" />
      </svg>
    </span>
  );
}
