import { useState } from "react";
import { invoke } from "../../busy";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { t, tCount, tn } from "../../i18n";
import { useToast } from "../../ToastContext";
import { useConfirm } from "../../ConfirmContext";
import type { PrintExportSummary, ProjectFileEntry, ReplaceOutcome, TransferDuplicate, TransferResult, TransferTarget } from "../../types";
import ReplaceReportDialog from "./ReplaceReportDialog";
import ReplaceFilesDialog from "./ReplaceFilesDialog";
import AddNoteDialog from "./AddNoteDialog";
import ProjectFilesView, { type ProjectFilesActionContext } from "./ProjectFilesView";
import PrintExportDialog from "./PrintExportDialog";
import ToolbarDropdown from "./ToolbarDropdown";
import TransferTargetDialog from "./TransferTargetDialog";
import TransferDuplicatesDialog from "./TransferDuplicatesDialog";
import TransferReportDialog from "./TransferReportDialog";
import { printExportBaseName } from "../../utils/printFilename";

/// Which cross-project operation the target dialog is currently open for.
type PendingTransfer = { mode: "copy" | "move"; items: ProjectFileEntry[] };

/// A transfer waiting for the user's decision about files the target has.
type DuplicatePrompt = { request: PendingTransfer; target: TransferTarget; duplicates: TransferDuplicate[] };

/// "Datei-Operationen": mass removal, copying and moving for files that are
/// already in this stream.
///
/// It looks like the "Hinzufügen" file manager on purpose — same tiles,
/// same preview panel, same double-click-to-mark — because it is the same
/// job pointed the other way. The one structural difference is the left
/// column: years out of the project database instead of folders off the
/// disk (see `ProjectYearNav`).
///
/// Nothing here is a new kind of deletion. "Entfernen" is the app's
/// ordinary soft removal, so the files land in the Papierkorb tab with a
/// normal undoable log entry rather than disappearing — permanent deletion
/// is only ever reachable from there, as a second, explicit step. The one
/// exception is "Arbeitskopie beim Entfernen löschen": with it on, the
/// backend purges right away, so removing asks first, same as the detail
/// viewer does.
interface Props {
  /// Forwarded to `ProjectFilesView` — set by `FileBrowser` when this tab
  /// was opened straight from the "Daten manuell überprüfen" checkbox
  /// after an insert, so only the files just added are shown here instead
  /// of the whole project.
  restrictToIds?: string[];
  /// Forwarded to `ProjectFilesView` — ids to pre-mark once this tab's list
  /// has loaded, set by `FileBrowser` when a timeline Ctrl-click selection
  /// was handed off via the floating "Ändern"-button/context-menu entry.
  autoMarkIds?: string[];
  /// Hands the given ids to the KI-Datumskorrektur tab, restricted to them.
  onSendToAi?: (ids: string[]) => void;
  /// Forwarded to `ProjectFilesView` — see its own doc comment.
  onDataChanged?: () => void;
  /// The "Arbeitskopie beim Entfernen löschen" setting — removing is then
  /// final and needs a confirmation.
  deleteFilesOnRemove?: boolean;
}

export default function FileOpsTab({ restrictToIds, autoMarkIds, onSendToAi, onDataChanged, deleteFilesOnRemove = false }: Props) {
  const showToast = useToast();
  const confirm = useConfirm();
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<DuplicatePrompt | null>(null);
  const [transferReport, setTransferReport] = useState<{ mode: "copy" | "move"; result: TransferResult } | null>(null);
  const [addingNoteTo, setAddingNoteTo] = useState<ProjectFileEntry[] | null>(null);
  const [printExportFor, setPrintExportFor] = useState<ProjectFileEntry[] | null>(null);
  const [replacingFor, setReplacingFor] = useState(false);
  const [replaceReport, setReplaceReport] = useState<ReplaceOutcome | null>(null);

  /// The batch actions on `ctx.marked`, shared by the toolbar dropdown and
  /// the tile context menu (which passes a ctx whose `marked` is the
  /// right-clicked file or the marked selection it belongs to). `close`
  /// dismisses the context menu first; the dropdown passes a no-op.
  function renderActionItems(ctx: ProjectFilesActionContext, close: () => void, itemClass = "toolbar-dropdown__item") {
    return (
      <div style={{ display: "contents" }} onClick={close}>
          <button
            className={itemClass}
            title={t("fileOps.changeDateHint")}
            onClick={() => ctx.changeDate(ctx.marked.map((entry) => entry.path))}
          >
            {t("fileOps.changeDateButton")}
          </button>
          {onSendToAi && (
            <button
              className={itemClass}
              title={t("fileOps.sendToAiHint")}
              onClick={() => onSendToAi(ctx.marked.map((entry) => entry.id))}
            >
              {t("fileOps.sendToAiButton")}
            </button>
          )}
          <button
            className={itemClass}
            title={t("fileOps.addNoteHint")}
            onClick={() => setAddingNoteTo(ctx.marked)}
          >
            {t("fileOps.addNoteButton")}
          </button>
          {([[-90, "fileOps.rotateLeftButton"], [90, "fileOps.rotateRightButton"]] as const).map(([delta, key]) => (
            <button
              key={key}
              className={itemClass}
              title={t("fileOps.rotateHint")}
              disabled={ctx.busy || ctx.marked.length === 0 || !ctx.marked.every((entry) => entry.kind === "image")}
              onClick={() => void rotatePhotos(ctx, ctx.marked, delta)}
            >
              {t(key)}
            </button>
          ))}
          <button
            className={itemClass}
            title={t("fileOps.copyHint")}
            onClick={() => setPending({ mode: "copy", items: ctx.marked })}
          >
            {t("fileOps.copyButton")}
          </button>
          <button
            className={itemClass}
            title={t("fileOps.moveHint")}
            onClick={() => setPending({ mode: "move", items: ctx.marked })}
          >
            {t("fileOps.moveButton")}
          </button>
          <button
            className={itemClass}
            title={t("fileOps.printExportHint")}
            onClick={() => setPrintExportFor(ctx.marked)}
          >
            {t("fileOps.printExportButton")}
          </button>
          <button
            className={itemClass}
            title={t("fileOps.pathListClipboardHint")}
            onClick={() => void copyPathList(ctx)}
          >
            {t("fileOps.pathListClipboardButton")}
          </button>
          <button
            className={itemClass}
            title={t("fileOps.pathListFileHint")}
            onClick={() => void savePathList(ctx)}
          >
            {t("fileOps.pathListFileButton")}
          </button>
          <button
            className={`${itemClass} toolbar-dropdown__item--danger context-menu__item--danger`}
            title={t("fileOps.removeHint")}
            onClick={async () => {
              const itemIds = ctx.marked.map((entry) => entry.id);
              if (deleteFilesOnRemove) {
                const confirmed = await confirm({
                  title: `${t("fileOps.removeButton")}?`,
                  body: `${tCount(itemIds.length, "fileOps.fileSelected", "fileOps.filesSelected")}. ${t("viewer.confirmRemoveDeleteBody")}`,
                  confirmLabel: t("log.purgeSelected"),
                });
                if (!confirmed) return;
              }
              void ctx.run(
                (operationId) => invoke<number>("remove_project_items", { itemIds, operationId }),
                (removed) =>
                  deleteFilesOnRemove
                    ? `${t("viewer.removedDeletedToast")} (${removed})`
                    : `${t("fileOps.removedToast")} (${removed})`,
                { label: t("fileOps.removeButton"), total: itemIds.length },
              );
            }}
          >
            {t("fileOps.removeButton")}
          </button>
      </div>
    );
  }

  function renderActions(ctx: ProjectFilesActionContext) {
    const count = ctx.marked.length;
    const nothingMarked = count === 0;

    return (
      <>
        <ToolbarDropdown label={`${t("fileOps.actionsMenu")} (${count})`} disabled={ctx.busy || nothingMarked}>
          {renderActionItems(ctx, () => undefined)}
        </ToolbarDropdown>

        {pending && (
          <TransferTargetDialog
            title={t(pending.mode === "move" ? "fileOps.moveDialogTitle" : "fileOps.copyDialogTitle")}
            count={pending.items.length}
            onCancel={() => setPending(null)}
            onPick={(target) => void checkTransfer(ctx, pending, target)}
          />
        )}

        {duplicatePrompt && (
          <TransferDuplicatesDialog
            mode={duplicatePrompt.request.mode}
            total={duplicatePrompt.request.items.length}
            targetName={duplicatePrompt.target.name}
            duplicates={duplicatePrompt.duplicates}
            onCancel={() => setDuplicatePrompt(null)}
            onSkip={() => {
              const { request, target } = duplicatePrompt;
              setDuplicatePrompt(null);
              void runTransfer(ctx, request, target, false);
            }}
            onIncludeAll={() => {
              const { request, target } = duplicatePrompt;
              setDuplicatePrompt(null);
              void runTransfer(ctx, request, target, true);
            }}
          />
        )}

        {transferReport && (
          <TransferReportDialog
            mode={transferReport.mode}
            result={transferReport.result}
            onConfirm={() => {
              ctx.markIds(transferReport.result.skipped.map((s) => s.itemId));
              setTransferReport(null);
            }}
          />
        )}

        {/* Not tied to the marked files: it looks through the whole
            Stream for what a chosen folder can replace. */}
        <button className="btn" title={t("fileOps.replaceHint")} disabled={ctx.busy} onClick={() => setReplacingFor(true)}>
          {t("fileOps.replaceButton")}
        </button>

        {replaceReport && <ReplaceReportDialog outcome={replaceReport} onClose={() => setReplaceReport(null)} />}

        {replacingFor && (
          <ReplaceFilesDialog
            onCancel={() => setReplacingFor(false)}
            onConfirm={(replacements) => {
              setReplacingFor(false);
              void ctx.run(
                async (operationId) => {
                  const outcome = await invoke<ReplaceOutcome>("replace_project_items", { replacements, operationId });
                  if (outcome.failed.length > 0) {
                    showToast(`${tn(outcome.failed.length, "fileOps.replaceFailedToast")}: ${outcome.failed[0]}`);
                  }
                  setReplaceReport(outcome);
                  return outcome.replaced;
                },
                () => "",
                { label: t("fileOps.replaceButton"), total: replacements.length },
              );
            }}
          />
        )}

        {printExportFor && (
          <PrintExportDialog
            photoCount={printExportFor.filter((entry) => entry.kind === "image").length}
            skippedCount={printExportFor.filter((entry) => entry.kind !== "image").length}
            onCancel={() => setPrintExportFor(null)}
            onConfirm={() => {
              const items = printExportFor;
              setPrintExportFor(null);
              void runPrintExport(ctx, items);
            }}
          />
        )}

        {addingNoteTo && (
          <AddNoteDialog
            count={addingNoteTo.length}
            onCancel={() => setAddingNoteTo(null)}
            onConfirm={(term) => void addNote(ctx, addingNoteTo, term)}
          />
        )}
      </>
    );
  }

  /// One full path per line for every marked file.
  async function copyPathList(ctx: ProjectFilesActionContext) {
    try {
      await writeClipboardText(ctx.marked.map((entry) => entry.path).join("\n"));
      showToast(`${t("fileOps.pathListClipboardToast")} (${ctx.marked.length})`);
    } catch (err) {
      showToast(String(err));
    }
  }

  async function savePathList(ctx: ProjectFilesActionContext) {
    const dest = await saveDialog({ defaultPath: "Pfadliste.txt", filters: [{ name: "Text", extensions: ["txt"] }] });
    if (!dest) return;
    try {
      await invoke<void>("write_text_file", { path: dest, content: ctx.marked.map((entry) => entry.path).join("\n") + "\n" });
      showToast(`${t("fileOps.pathListFileToast")} (${ctx.marked.length})`);
    } catch (err) {
      showToast(String(err));
    }
  }

  /// "Notiz hinzufügen" — tags every marked file with `term`, added to
  /// whatever note it already has (see `append_note_term` on the Rust
  /// side). Two or more files that end up sharing the exact same note text
  /// become a cluster: the Timeline viewer makes an identical note
  /// clickable and hands the whole group off back to this tab.
  async function addNote(ctx: ProjectFilesActionContext, items: ProjectFileEntry[], term: string) {
    setAddingNoteTo(null);
    await ctx.run(
      async () => {
        await invoke<void>("add_note_to_items", { itemIds: items.map((entry) => entry.id), term });
        return items.length;
      },
      (count) => `${t("fileOps.addNoteToast")} (${count})`,
    );
  }

  /// "Links/Rechts drehen" — turns every marked photo by 90°. Only the
  /// rotation value in the database changes (see `rotate_items`).
  async function rotatePhotos(ctx: ProjectFilesActionContext, items: ProjectFileEntry[], delta: number) {
    await ctx.run(
      async () => {
        await invoke<number>("rotate_items", { itemIds: items.map((entry) => entry.id), delta });
        return items.length;
      },
      (count) => `${t("fileOps.rotateToast")} (${count})`,
    );
  }

  /// "Druckexport…" — copies the marked photos into a folder of the user's
  /// choice, each named after its timeline date (see `printExportBaseName`),
  /// oldest first so that two photos from the same minute get " - 2" in a
  /// predictable order. Rotation is applied to the copy; the originals in
  /// the project stay untouched.
  async function runPrintExport(ctx: ProjectFilesActionContext, items: ProjectFileEntry[]) {
    const photos = items
      .filter((entry) => entry.kind === "image")
      .sort((a, b) => new Date(a.resolvedTimestamp).getTime() - new Date(b.resolvedTimestamp).getTime());
    if (photos.length === 0) return;
    const dest = await openDialog({ directory: true, multiple: false, title: t("fileOps.printExportDialogTitle") });
    if (!dest || Array.isArray(dest)) return;
    await ctx.run(
      async () => {
        const summary = await invoke<PrintExportSummary>("run_print_export", {
          entries: photos.map((entry) => ({ id: entry.id, base_name: printExportBaseName(entry.resolvedTimestamp) })),
          destFolder: dest,
        });
        if (summary.failed.length > 0) {
          showToast(`${tn(summary.failed.length, "fileOps.printExportFailedToast")}: ${summary.failed[0].reason}`);
        }
        return summary.exported;
      },
      (exported) => tn(exported, "fileOps.printExportToast"),
      { label: t("fileOps.printExportButton"), total: photos.length },
    );
  }

  /// Both cross-project buttons end up here; the only difference reaching
  /// the backend is `moveMode`, which decides whether the source items are
  /// removed after the copy is confirmed (see `transfer_items`).
  async function checkTransfer(ctx: ProjectFilesActionContext, request: PendingTransfer, target: TransferTarget) {
    setPending(null);
    try {
      const duplicates = await invoke<TransferDuplicate[]>("preview_transfer_duplicates", {
        targetPath: target.path,
        itemIds: request.items.map((entry) => entry.id),
      });
      if (duplicates.length > 0) {
        setDuplicatePrompt({ request, target, duplicates });
        return;
      }
    } catch (err) {
      showToast(String(err));
      return;
    }
    await runTransfer(ctx, request, target, false);
  }

  async function runTransfer(ctx: ProjectFilesActionContext, request: PendingTransfer, target: TransferTarget, includeDuplicates: boolean) {
    await ctx.run(
      async () => {
        const result = await invoke<TransferResult>("transfer_items", {
          targetPath: target.path,
          itemIds: request.items.map((entry) => entry.id),
          moveMode: request.mode === "move",
          includeDuplicates,
        });
        // A skip is the one outcome the user has to act on themselves, so
        // it gets a dialog naming every file rather than a toast.
        if (result.skipped.length > 0) setTransferReport({ mode: request.mode, result });
        return result.transferred;
      },
      (transferred) =>
        request.mode === "move"
          ? `${tn(transferred, "fileOps.movedToast")} ${target.name}`
          : `${tn(transferred, "fileOps.copiedToast")} ${target.name}`,
    );
  }

  return (
    <ProjectFilesView
      trashed={false}
      emptyMessage={t("fileOps.empty")}
      renderActions={renderActions}
      renderContextActions={(ctx, close) => renderActionItems(ctx, close, "context-menu__item")}
      restrictToIds={restrictToIds}
      autoMarkIds={autoMarkIds}
      onDataChanged={onDataChanged}
    />
  );
}
