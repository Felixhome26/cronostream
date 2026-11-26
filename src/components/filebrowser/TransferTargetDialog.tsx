import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "../../busy";
import { t, tCount } from "../../i18n";
import type { TransferTarget } from "../../types";

interface Props {
  /// What the pick is for, so the dialog can name it ("… kopieren nach" vs.
  /// "… verschieben nach").
  title: string;
  /// How many files the pick applies to, shown so a batch action can't be
  /// confirmed without seeing its size.
  count: number;
  onPick: (target: TransferTarget) => void;
  onCancel: () => void;
}

/// Picks the stream a copy or move should go to.
///
/// The list comes from `list_transfer_targets` — the same recent-projects
/// list the start screen shows, minus the open project — and never from a
/// folder picker. That is a deliberate guard carried over from the
/// Transfer tab: a transfer cannot land in a folder that merely looks like
/// a stream, because the only reachable targets are ones the app has
/// already opened and verified.
export default function TransferTargetDialog({ title, count, onPick, onCancel }: Props) {
  const [targets, setTargets] = useState<TransferTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  async function createAndPick() {
    const name = newName.trim();
    if (!name) return;
    const parent = await openDialog({ directory: true, multiple: false, title: t("start.chooseLocation") });
    if (!parent || Array.isArray(parent)) return;
    setCreateBusy(true);
    setError(null);
    try {
      const target = await invoke<TransferTarget>("create_transfer_target", { name, parentPath: parent });
      onPick(target);
    } catch (e) {
      setError(typeof e === "string" ? e : t("start.errorGeneric"));
      setCreateBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    invoke<TransferTarget[]>("list_transfer_targets")
      .then((list) => {
        if (!cancelled) setTargets(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setTargets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal-card modal-card--wide" onMouseDown={(ev) => ev.stopPropagation()}>
        <h2 className="modal-card__title">{title}</h2>
        <p className="modal-card__body">
          {tCount(count, "fileOps.fileSelected", "fileOps.filesSelected")}
        </p>

        {error && <div className="transfer__warning">{error}</div>}

        {targets !== null &&
          (creating ? (
            <div className="transfer__new-target">
              <input
                className="text-input"
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                placeholder={t("start.namePlaceholder")}
                autoFocus
                disabled={createBusy}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") void createAndPick();
                }}
              />
              <button
                className="btn btn--primary"
                onClick={() => void createAndPick()}
                disabled={createBusy || !newName.trim()}
              >
                {t("transfer.newTargetCreate")}
              </button>
            </div>
          ) : (
            <button className="btn" onClick={() => setCreating(true)}>
              {t("transfer.newTarget")}
            </button>
          ))}

        {targets === null ? (
          <p className="transfer__hint">{t("transfer.targetsLoading")}</p>
        ) : targets.length === 0 && !creating ? (
          <p className="transfer__hint">{t("transfer.noTargets")}</p>
        ) : (
          <div className="tile-grid">
            {targets.map((candidate) => (
              <div
                key={candidate.path}
                className={"project-tile" + (candidate.busy ? " project-tile--disabled" : "")}
                onClick={() => !candidate.busy && onPick(candidate)}
                title={candidate.busy ? t("transfer.targetBusy") : candidate.path}
              >
                <div className="project-tile__icon">🎞️</div>
                <div className="project-tile__name">{candidate.name}</div>
                <div className="transfer__target-picker-count">
                  {tCount(candidate.itemCount, "transfer.itemThere", "transfer.itemsThere")}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="modal-card__actions">
          <button className="btn" onClick={onCancel}>
            {t("browser.folderCancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
