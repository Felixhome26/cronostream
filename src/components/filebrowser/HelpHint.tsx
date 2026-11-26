interface Props {
  text: string;
}

/// Small "?" badge that shows `text` via the native `title` tooltip on
/// hover — same mechanism the rest of the app already uses for hints (see
/// e.g. the category-rail buttons in `FileBrowser.tsx`), just as its own
/// discoverable icon next to a label instead of riding along on a control
/// that already does something else.
export default function HelpHint({ text }: Props) {
  return (
    <span className="help-hint" title={text} aria-label={text}>
      ?
    </span>
  );
}
