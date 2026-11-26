import { useState } from "react";
import { invoke } from "../../busy";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import type { ReplacementMatch, ReplacementScan } from "../../types";
import { formatBytes } from "../DeleteStreamDialog";

interface Props {
  onCancel: () => void;
  /// One entry per file to replace: the item and the chosen new file.
  onConfirm: (replacements: { itemId: string; newPath: string }[]) => void;
}

type Phase = "intro" | "scanning" | "review";

/// "Datei im Stream ersetzen" (always checks the whole Stream) — explanation first (so nobody picks a
/// folder without knowing what will happen), then the folder choice, then a
/// review list of what was found. Nothing is changed before the final
/// button; the actual swap runs in the parent via `replace_project_items`.
export default function ReplaceFilesDialog({ onCancel, onConfirm }: Props) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [scan, setScan] = useState<ReplacementScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per item: whether it is included, and which candidate is chosen.
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});

  async function chooseFolder() {
    const folder = await openDialog({ directory: true, multiple: false, title: t("replace.folderDialogTitle") });
    if (!folder || Array.isArray(folder)) return;
    setPhase("scanning");
    setError(null);
    try {
      const result = await invoke<ReplacementScan>("find_replacement_matches", {
        itemIds: null,
        folder,
      });
      const inc: Record<string, boolean> = {};
      const sel: Record<string, string> = {};
      for (const match of result.matches) {
        // Ambiguous files (several candidates) are not preselected: the
        // user has to say which one is meant.
        inc[match.itemId] = match.candidates.length === 1;
        sel[match.itemId] = match.candidates[0].path;
      }
      setScan(result);
      setIncluded(inc);
      setChosen(sel);
      setPhase("review");
    } catch (err) {
      setError(String(err));
      setPhase("intro");
    }
  }

  const selectedCount = scan ? scan.matches.filter((m) => included[m.itemId]).length : 0;
  const withoutSource = scan ? scan.matches.filter((m) => included[m.itemId] && !m.sourceAvailable).length : 0;

  function savedHint(match: ReplacementMatch): string {
    const candidate = match.candidates.find((c) => c.path === chosen[match.itemId]);
    if (!candidate || candidate.sizeBytes == null || match.currentSizeBytes == null) return "";
    return `${formatBytes(match.currentSizeBytes)} → ${formatBytes(candidate.sizeBytes)}`;
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal-card modal-card--wide replace-dialog" onMouseDown={(ev) => ev.stopPropagation()}>
        <h2 className="modal-card__title">{t("replace.title")}</h2>

        {phase === "intro" && (
          <>
            <div className="modal-card__body replace-dialog__explain">
              <p>{t("replace.explainPurpose")}</p>
              <p>
                <strong>{t("replace.explainHowTitle")}</strong>
              </p>
              <ul>
                <li>{t("replace.explainHow1")}</li>
                <li>{t("replace.explainHow2")}</li>
                <li>{t("replace.explainHow3")}</li>
                <li>{t("replace.explainHow4")}</li>
              </ul>
              <p>
                <strong>{t("replace.explainKeptTitle")}</strong> {t("replace.explainKept")}
              </p>
              <p>
                <strong>{t("replace.explainUndoTitle")}</strong> {t("replace.explainUndo")}
              </p>
              <p className="replace-dialog__warn">{t("replace.explainWarning")}</p>
            </div>
            {error && <p className="modal-card__error">{error}</p>}
            <div className="modal-card__actions">
              <button className="btn" onClick={onCancel}>
                {t("browser.folderCancel")}
              </button>
              <button className="btn btn--primary" onClick={() => void chooseFolder()}>
                {t("replace.chooseFolder")}
              </button>
            </div>
          </>
        )}

        {phase === "scanning" && <p className="modal-card__body">{t("replace.scanning")}</p>}

        {phase === "review" && scan && (
          <>
            <p className="modal-card__body">
              {scan.matches.length === 0
                ? t("replace.noMatches")
                : `${scan.matches.length} ${t("replace.foundOf")} ${scan.checkedItems} (${scan.folderFiles} ${t("replace.folderFiles")})`}
            </p>
            {scan.matches.length > 0 && (
              <div className="replace-dialog__list">
                {scan.matches.map((match) => (
                  <div key={match.itemId} className="replace-dialog__row">
                    <label className="replace-dialog__name" title={match.name}>
                      <input
                        type="checkbox"
                        checked={!!included[match.itemId]}
                        onChange={(ev) => setIncluded({ ...included, [match.itemId]: ev.target.checked })}
                      />
                      <span>{match.name}</span>
                    </label>
                    {match.candidates.length === 1 ? (
                      <span className="replace-dialog__cand" title={match.candidates[0].path}>
                        → {match.candidates[0].name}
                      </span>
                    ) : (
                      <select
                        className="replace-dialog__cand"
                        value={chosen[match.itemId]}
                        onChange={(ev) => {
                          setChosen({ ...chosen, [match.itemId]: ev.target.value });
                          setIncluded({ ...included, [match.itemId]: true });
                        }}
                      >
                        {match.candidates.map((c) => (
                          <option key={c.path} value={c.path}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="replace-dialog__size">{savedHint(match)}</span>
                    {!match.sourceAvailable && (
                      <span className="replace-dialog__warn" title={t("replace.noSourceHint")}>
                        ⚠ {t("replace.noSource")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {withoutSource > 0 && (
              <p className="replace-dialog__warn">
                {withoutSource} {t("replace.noSourceSummary")}
              </p>
            )}
            <div className="modal-card__actions">
              <button className="btn" onClick={onCancel}>
                {t("browser.folderCancel")}
              </button>
              <button className="btn" onClick={() => setPhase("intro")}>
                {t("replace.otherFolder")}
              </button>
              <button
                className="btn btn--primary"
                disabled={selectedCount === 0}
                onClick={() =>
                  onConfirm(
                    scan.matches
                      .filter((m) => included[m.itemId])
                      .map((m) => ({ itemId: m.itemId, newPath: chosen[m.itemId] })),
                  )
                }
              >
                {`${selectedCount} ${t("replace.confirm")}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
