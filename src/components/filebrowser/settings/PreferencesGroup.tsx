import type { ReactNode } from "react";

/// A titled card of hairline-separated rows.
export default function PreferencesGroup({
  title,
  intro,
  children,
}: {
  title?: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section className="prefs-group">
      {title && <h4 className="prefs-group__title">{title}</h4>}
      {intro && <p className="prefs-group__intro">{intro}</p>}
      <div className="prefs-group__box">{children}</div>
    </section>
  );
}
