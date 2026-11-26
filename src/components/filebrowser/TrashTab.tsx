import { invoke } from "../../busy";
import { t, tCount } from "../../i18n";
import { useConfirm } from "../../ConfirmContext";
import ProjectFilesView, { type ProjectFilesActionContext } from "./ProjectFilesView";
import ToolbarDropdown from "./ToolbarDropdown";
import HelpHint from "./HelpHint";

/// "Papierkorb": the files this stream has taken off its timeline
/// (`items.removed_at IS NOT NULL`), with the three ways out.
///
/// Not a new mechanism — there is no `is_trashed` column and no second
/// soft-delete path. This is a view over the flag the app has set on every
/// removal since the action log was built, which is why files removed from
/// the timeline, from the file browser or by an undone import all show up
/// here without any of those paths knowing about this tab.
///
/// Same year navigation as "Datei-Operationen", deliberately: the Papierkorb
/// is usually much smaller, but a second navigation metaphor for the same
/// kind of list would cost more than the width it saves.
///
/// The three actions are three genuinely different degrees of finality:
/// restore puts the file back, "nur Datei löschen" frees the disk space but
/// keeps the item (so it can still be re-imported from the original), and
/// the last one erases the item and its whole log history for good.
interface Props {
  /// Forwarded to `ProjectFilesView` — see its own doc comment.
  onDataChanged?: () => void;
}

export default function TrashTab({ onDataChanged }: Props) {
  const confirm = useConfirm();

  function renderActions(ctx: ProjectFilesActionContext) {
    const count = ctx.marked.length;
    const nothingMarked = count === 0;
    // Only files whose in-project copy is still there have anything left to
    // delete; a row whose file is already gone would make the button a
    // no-op that still reports success.
    const withFiles = ctx.marked.filter((entry) => entry.filePresent);

    return (
      <>
      <ToolbarDropdown label={`${t("fileOps.actionsMenu")} (${count})`} disabled={ctx.busy || nothingMarked}>
        <button
          className="toolbar-dropdown__item"
          title={t("trash.restoreHint")}
          onClick={() =>
            void ctx.run(
              (operationId) =>
                invoke<number>("restore_project_items", { itemIds: ctx.marked.map((entry) => entry.id), operationId }),
              (restored) =>
                restored === count
                  ? `${t("trash.restoredToast")} (${restored})`
                  : `${t("trash.restoredToast")} (${restored}/${count}) — ${t("trash.restorePartial")}`,
              { label: t("trash.restoreButton"), total: ctx.marked.length },
            )
          }
        >
          {t("trash.restoreButton")}
        </button>

        <button
          className="toolbar-dropdown__item toolbar-dropdown__item--danger"
          disabled={withFiles.length === 0}
          title={t("trash.deleteFilesHint")}
          onClick={async () => {
            const itemIds = withFiles.map((entry) => entry.id);
            const confirmed = await confirm({
              title: `${t("trash.deleteFilesButton")}?`,
              body: `${tCount(itemIds.length, "fileOps.fileSelected", "fileOps.filesSelected")}. ${t("trash.confirmDeleteFilesBody")}`,
              confirmLabel: t("trash.deleteFilesButton"),
            });
            if (!confirmed) return;
            void ctx.run(
              (operationId) => invoke<number>("delete_item_files_only", { itemIds, operationId }),
              (deleted) => `${t("trash.deleteFilesToast")} (${deleted})`,
              { label: t("trash.deleteFilesButton"), total: itemIds.length },
            );
          }}
        >
          {`${t("trash.deleteFilesButton")} (${withFiles.length})`}
        </button>

        <button
          className="toolbar-dropdown__item toolbar-dropdown__item--danger"
          title={t("trash.purgeHint")}
          onClick={async () => {
            const itemIds = ctx.marked.map((entry) => entry.id);
            const confirmed = await confirm({
              title: `${t("trash.purgeButton")}?`,
              body: `${tCount(itemIds.length, "fileOps.fileSelected", "fileOps.filesSelected")}. ${t("trash.confirmPurgeBody")}`,
              confirmLabel: t("trash.purgeButton"),
            });
            if (!confirmed) return;
            void ctx.run(
              (operationId) => invoke<number>("purge_items_and_log", { itemIds, operationId }),
              (purged) => `${t("trash.purgedToast")} (${purged})`,
              { label: t("trash.purgeButton"), total: itemIds.length },
            );
          }}
        >
          {t("trash.purgeButton")}
        </button>
      </ToolbarDropdown>
      <HelpHint text={t("trash.actionsOverviewHint")} />
      </>
    );
  }

  return (
    <ProjectFilesView trashed emptyMessage={t("trash.empty")} renderActions={renderActions} onDataChanged={onDataChanged} />
  );
}
