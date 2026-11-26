/// True while the file-browser overlay is kept mounted but hidden so the
/// live timeline can be consulted (see ProjectShell's peek). The browser's
/// window-level key handlers must stand down then, or Ctrl+A / arrow keys
/// aimed at the visible timeline would act on the invisible file list.
export function isBrowserPeeking(): boolean {
  return document.body.classList.contains("browser-peek");
}
