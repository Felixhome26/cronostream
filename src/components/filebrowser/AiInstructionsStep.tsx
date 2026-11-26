import { useState } from "react";
import { invoke } from "../../busy";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { t } from "../../i18n";
import { useProgress } from "../../ProgressContext";
import HelpHint from "./HelpHint";

interface Props {
  /// The ids picked in step 1 — what the clipboard export is built from.
  selectedIds: string[];
  /// Called once the export text (remark + data) has been copied to the
  /// clipboard, with the ids it covers — the caller tracks these as the
  /// batch an AI reply should cover.
  onCopied: (ids: string[], savedAsFile?: boolean) => void;
  onCopyFailed: () => void;
  onBack: () => void;
}

/// Step 2 of the AI date-correction wizard: lets the user optionally add
/// free-text instructions for the AI, then copies the export (remark +
/// item data) to the clipboard in one go.
export default function AiInstructionsStep({ selectedIds, onCopied, onCopyFailed, onBack }: Props) {
  const [extraText, setExtraText] = useState("");
  const [busy, setBusy] = useState(false);
  const { startOperation, finishOperation } = useProgress();

  async function copyToClipboard() {
    const extraInstructions = extraText.trim() ? extraText.trim() : null;
    setBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.aiMetadata.instructionsTitle"), total: selectedIds.length });
    try {
      const content = await invoke<string>("build_ai_metadata_export_text", {
        ids: selectedIds,
        extraInstructions,
        followup: false,
        operationId,
      });
      await writeClipboardText(content);
      onCopied(selectedIds);
    } catch {
      onCopyFailed();
    } finally {
      setBusy(false);
      finishOperation(operationId);
    }
  }

  async function saveToFile() {
    const extraInstructions = extraText.trim() ? extraText.trim() : null;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const destPath = await saveDialog({
      defaultPath: `cronostream-ki-metadaten-export_${stamp}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!destPath) return;

    setBusy(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("browser.aiMetadata.instructionsTitle"), total: selectedIds.length });
    try {
      await invoke<number>("export_ai_metadata", { ids: selectedIds, destPath, extraInstructions, operationId });
      onCopied(selectedIds, true);
    } catch {
      onCopyFailed();
    } finally {
      setBusy(false);
      finishOperation(operationId);
    }
  }

  return (
    <div className="ai-metadata__panel">
      <h2>
        {t("browser.aiMetadata.instructionsTitle")} <HelpHint text={t("browser.aiMetadata.externalAiHint")} />
      </h2>
      <p className="ai-metadata__instructions">{t("browser.aiMetadata.instructionsDescription")}</p>

      <div className="ai-metadata__extra">
        <label className="ai-metadata__extra-label">{t("browser.aiMetadata.extraLabel")}</label>
        <textarea
          className="ai-metadata__extra-input"
          value={extraText}
          onChange={(e) => setExtraText(e.target.value)}
          placeholder={t("browser.aiMetadata.extraPlaceholder")}
          rows={3}
        />
      </div>

      <div className="ai-metadata__step-actions">
        <button className="btn--text" onClick={onBack}>
          {t("browser.aiMetadata.backButton")}
        </button>
        <button className="btn btn--primary" onClick={copyToClipboard} disabled={busy}>
          {t("browser.aiMetadata.copyToClipboardButton")}
        </button>
        <button className="btn btn--secondary" onClick={saveToFile} disabled={busy}>
          {t("browser.aiMetadata.saveToFileButton")}
        </button>
      </div>
    </div>
  );
}
