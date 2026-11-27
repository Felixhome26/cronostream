import { useState } from "react";
import { invoke } from "../../busy";
import { t, tn } from "../../i18n";
import { useProgress } from "../../ProgressContext";
import { useToast } from "../../ToastContext";
import type { DuplicateGroup } from "../../types";

interface Props {
  /// Called with every item id from every duplicate group the scan found,
  /// once the user chooses to hand them off — switches to Datei-Operationen
  /// restricted to just those ids.
  onDuplicatesFound: (ids: string[]) => void;
}

/// Manual full-project duplicate scan, moved here from a Settings row so it
/// sits alongside Datei-Operationen under "Verwalten" — both are
/// project-maintenance actions, not everyday settings. See `BackupTab` for
/// the same move made earlier for the backup button.
///
/// Complements "Beim Einfügen auf Duplikate prüfen" (Einstellungen): that
/// setting only ever looks at files as they arrive, so anything imported
/// before it was turned on — or while the "Vorfilter" sub-setting ruled a
/// renamed duplicate out — never gets checked. This backfills any missing
/// `quick_hash` across the whole stream and groups it by the result,
/// same "schnell" confidence `find_duplicate` already relies on elsewhere.
export default function DuplicatesTab({ onDuplicatesFound }: Props) {
  const { startOperation, finishOperation } = useProgress();
  const showToast = useToast();
  const [scanning, setScanning] = useState(false);
  // The last outcome of each scan, kept in the view as well: the toast is
  // gone after a few seconds, and on return the tab looked as if nothing
  // had run at all.
  const [duplicateResult, setDuplicateResult] = useState<ScanResult | null>(null);
  const [similarResult, setSimilarResult] = useState<ScanResult | null>(null);

  /// Reports the outcome as a toast rather than inline text: the scan can
  /// run long enough on a large stream that the user has switched to
  /// another tab by the time it finishes, and the only thing that stayed
  /// visible until now was the small progress chip in the corner, which
  /// just vanished on completion with nothing to say *what* happened. A
  /// toast is global and outlives the tab switch; the "found" case carries
  /// the handoff to Datei-Operationen as its action button instead of a
  /// separate control the user would have to notice first.
  async function scanForDuplicates() {
    setScanning(true);
    const operationId = crypto.randomUUID();
    // Item count isn't known until the backend has counted the project —
    // starts at 0 and is corrected by the first progress event.
    startOperation({ id: operationId, label: t("browser.duplicates.progressLabel"), total: 0 });
    try {
      const groups = await invoke<DuplicateGroup[]>("scan_project_for_duplicates", { operationId });
      if (groups.length === 0) {
        showToast(t("browser.duplicates.none"));
        setDuplicateResult({ text: t("browser.duplicates.none"), ids: [] });
      } else {
        const duplicateItemCount = groups.reduce((sum, group) => sum + group.item_ids.length, 0);
        const text = tn(duplicateItemCount, "browser.duplicates.found", {
          groups: tn(groups.length, "browser.duplicates.groupCount"),
        });
        setDuplicateResult({ text, ids: groups.flatMap((group) => group.item_ids) });
        showToast(
          text,
          {
            durationMs: 8000,
            action: {
              label: t("browser.duplicates.handoff"),
              onClick: () => onDuplicatesFound(groups.flatMap((group) => group.item_ids)),
            },
          },
        );
      }
    } catch (e) {
      showToast(typeof e === "string" ? e : t("browser.duplicates.error"));
    } finally {
      setScanning(false);
      finishOperation(operationId);
    }
  }

  /// Same shape as the duplicate scan above, for photos that look alike
  /// without being byte-identical (see `similar_images.rs`). Only ever a
  /// suggestion: the handoff shows them in Datei-Operationen to decide there.
  async function scanForSimilar() {
    setScanning(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.similar.progressLabel"), total: 0 });
    try {
      const groups = await invoke<DuplicateGroup[]>("scan_similar_images", { operationId });
      if (groups.length === 0) {
        showToast(t("browser.similar.none"));
        setSimilarResult({ text: t("browser.similar.none"), ids: [] });
      } else {
        const count = groups.reduce((sum, group) => sum + group.item_ids.length, 0);
        const text = tn(count, "browser.similar.found", { groups: tn(groups.length, "browser.duplicates.groupCount") });
        setSimilarResult({ text, ids: groups.flatMap((group) => group.item_ids) });
        showToast(text, {
          durationMs: 8000,
          action: {
            label: t("browser.duplicates.handoff"),
            onClick: () => onDuplicatesFound(groups.flatMap((group) => group.item_ids)),
          },
        });
      }
    } catch (e) {
      showToast(typeof e === "string" ? e : t("browser.duplicates.error"));
    } finally {
      setScanning(false);
      finishOperation(operationId);
    }
  }

  return (
    <div className="duplicates-tab">
      <p className="duplicates-tab__hint">{t("browser.duplicates.hint")}</p>
      <button className="btn btn--primary" onClick={() => void scanForDuplicates()} disabled={scanning}>
        {scanning ? t("browser.duplicates.progressLabel") : t("browser.duplicates.button")}
      </button>
      <ScanResultLine result={duplicateResult} onHandoff={onDuplicatesFound} />
      <p className="duplicates-tab__hint">{t("browser.similar.hint")}</p>
      <button className="btn" onClick={() => void scanForSimilar()} disabled={scanning}>
        {scanning ? t("browser.similar.progressLabel") : t("browser.similar.button")}
      </button>
      <ScanResultLine result={similarResult} onHandoff={onDuplicatesFound} />
    </div>
  );
}

interface ScanResult {
  text: string;
  /// The files found, for the hand-over to Datei-Operationen; empty when
  /// nothing was found.
  ids: string[];
}

function ScanResultLine({ result, onHandoff }: { result: ScanResult | null; onHandoff: (ids: string[]) => void }) {
  if (!result) return null;
  return (
    <p className="duplicates-tab__result" role="status">
      {result.text}
      {result.ids.length > 0 && (
        <button className="btn--text" onClick={() => onHandoff(result.ids)}>
          {t("browser.duplicates.handoff")}
        </button>
      )}
    </p>
  );
}
