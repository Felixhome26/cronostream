// While a dialog that takes dropped files for itself is open (the diary
// entry), the main window's drop handler (PendingDrops) must stay out of it —
// otherwise the same drop would also queue the files for import.
let suppressed = 0;

export function suppressGlobalFileDrops(): () => void {
  suppressed += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      suppressed -= 1;
    }
  };
}

export function globalFileDropsSuppressed(): boolean {
  return suppressed > 0;
}
