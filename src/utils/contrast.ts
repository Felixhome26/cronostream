// Text colour on a user-chosen background (the phase bars). Plain WCAG 2.x
// maths, no DOM: the colour comes from the database, not from a stylesheet.

/// Relative luminance of "#rrggbb" (0 = black, 1 = white), or null when the
/// string isn't a colour.
export function relativeLuminance(hex: string): number | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/// WCAG contrast ratio between two luminances, 1 … 21.
export function contrastRatio(a: number, b: number): number {
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/// Black or white, whichever reads better on `background`.
///
/// Picking the larger of the two ratios is enough for WCAG AA: the ratios
/// against black and white multiply to 21, so the better one is never below
/// √21 ≈ 4.58 — above the 4.5:1 that normal-size text needs, for every
/// colour there is. An unparseable colour gets white, which matches the
/// app's dark surfaces.
export function readableTextColor(background: string): "#000000" | "#ffffff" {
  const luminance = relativeLuminance(background);
  if (luminance == null) return "#ffffff";
  return contrastRatio(luminance, 0) > contrastRatio(luminance, 1) ? "#000000" : "#ffffff";
}
