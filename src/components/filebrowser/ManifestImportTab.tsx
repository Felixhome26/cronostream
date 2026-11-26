import { useState } from "react";
import { invoke } from "../../busy";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import { useProgress } from "../../ProgressContext";
import type { ManifestImportResult } from "../../types";
import type { PickedList } from "../../hooks/usePickedList";
import FinalReviewModal from "./FinalReviewModal";

interface Props {
  picks: PickedList;
  onInserted: (insertedPaths: string[], message: string) => void;
  /// Forwarded straight to `FinalReviewModal` — see its own doc comment.
  onDuplicatesFound: (ids: string[]) => void;
}

/// Reads a text file listing one file path per line and stages every usable
/// line for review — no per-file confirmation, unlike the single-image
/// view's Enter-to-mark flow. Keeps its own independent picked list.
///
/// Not to be confused with the unrelated, already-existing support for
/// adding a `.txt` file *itself* as a timeline item with extracted text —
/// here a `.txt` is a list of paths to other files, never an item itself.
export default function ManifestImportTab({ picks, onInserted, onDuplicatesFound }: Props) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const { startOperation, finishOperation } = useProgress();

  async function pickManifest() {
    const manifestPath = await openDialog({
      multiple: false,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!manifestPath || Array.isArray(manifestPath)) return;

    setBusy(true);
    setSummary(null);
    const operationId = crypto.randomUUID();
    // Line count isn't known until the backend has read the file — starts
    // at 0 and is corrected by the first progress event.
    startOperation({ id: operationId, label: t("browser.tabs.manifest"), total: 0 });
    try {
      const result = await invoke<ManifestImportResult>("import_paths_from_manifest", { manifestPath, operationId });
      picks.addMany(result.valid);
      if (result.invalid_count > 0) {
        setSummary(`${result.invalid_count} / ${result.total_lines} ${t("browser.manifest.invalidSummarySuffix")}`);
      } else if (result.valid.length > 0) {
        setSummary(`${result.valid.length} ${t("browser.manifest.allValidSummarySuffix")}`);
      }
    } catch {
      setSummary(t("browser.manifest.readFailed"));
    } finally {
      setBusy(false);
      finishOperation(operationId);
    }
  }

  return (
    <div className="manifest-import">
      <div className="manifest-import__panel">
        <h2>{t("browser.tabs.manifest")}</h2>
        <p className="manifest-import__instructions">{t("browser.manifest.instructions")}</p>

        <button className="btn btn--primary" onClick={pickManifest} disabled={busy}>
          {t("browser.manifest.openFile")}
        </button>

        {summary && <div className="manifest-import__summary">{summary}</div>}

        {picks.count > 0 && (
          <div className="manifest-import__actions">
            <span className="manifest-import__count">
              {picks.count} {t("browser.manifest.pickedBadge")}
            </span>
            <button className="btn btn--primary" onClick={() => setReviewOpen(true)}>
              {t("browser.insertButton")}
            </button>
          </div>
        )}
      </div>

      {reviewOpen && (
        <FinalReviewModal
          items={[...picks.picked.values()]}
          onClose={() => setReviewOpen(false)}
          onInserted={(insertedPaths, message) => {
            insertedPaths.forEach((p) => picks.remove(p));
            onInserted(insertedPaths, message);
            if (picks.count - insertedPaths.length <= 0) setReviewOpen(false);
          }}
          onDuplicatesFound={onDuplicatesFound}
        />
      )}
    </div>
  );
}
