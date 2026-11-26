import { t } from "../i18n";
import type { DuplicateGroup } from "../types";

type ShowToast = (message: string, options?: { durationMs?: number; action?: { label: string; onClick: () => void } }) => void;

/// Shown after any insert path when "Beim Einfügen auf Duplikate prüfen"
/// caught the just-added batch colliding with something by `quick_hash` —
/// same wording as the Duplikate-Reiter's own toast (see `DuplicatesTab`),
/// with the action button jumping straight to Datei-Operationen restricted
/// to every id involved (both the new arrivals and whatever they matched).
export function notifyDuplicatesFound(showToast: ShowToast, groups: DuplicateGroup[], onHandoff: (ids: string[]) => void) {
  if (groups.length === 0) return;
  const ids = groups.flatMap((group) => group.item_ids);
  showToast(
    t("browser.duplicatesFoundOnInsert").replace("{count}", String(ids.length)).replace("{groups}", String(groups.length)),
    {
      durationMs: 8000,
      action: { label: t("browser.duplicates.handoff"), onClick: () => onHandoff(ids) },
    },
  );
}
