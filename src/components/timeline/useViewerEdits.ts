import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "../../busy";
import type { ItemInfo } from "../../types";
import { t } from "../../i18n";
import { fromDatetimeLocalValue, toDatetimeLocalValue } from "../../utils/datetime";
import { effectiveName } from "../../utils/timeline/itemText";

interface Options {
  viewerItem: ItemInfo | null;
  setItems: Dispatch<SetStateAction<ItemInfo[]>>;
  setViewerItem: Dispatch<SetStateAction<ItemInfo | null>>;
  showToast: (message: string) => void;
}

/// What the detail view lets the user edit about the open file — its name,
/// its date and its note — with the drafts and the writes behind them.
/// Moved out of Timeline.tsx unchanged; the timeline still drives it (it
/// resets the drafts when it shows another file, see openViewer/closeViewer).
export function useViewerEdits({ viewerItem, setItems, setViewerItem, showToast }: Options) {
  const [nameDraft, setNameDraft] = useState("");
  // Renaming in the viewer is an explicit, confirmed edit: clicking into the
  // name field starts it and reveals the confirm button, and only that
  // button (or Enter) writes. Blur deliberately does NOT save — it fires
  // before the button's own click, so saving there would make the button
  // either redundant or unreachable, and it would turn "clicked somewhere
  // else to abandon this" into a silent write.
  const [nameEditing, setNameEditing] = useState(false);
  const [nameError, setNameError] = useState(false);
  // The note field under the detail view. Unlike the name, this one saves
  // without a confirm step, on a short debounce — a note is typed in prose,
  // so one IPC round-trip per keystroke would be wasteful, and a confirm
  // button would be one more thing to forget before closing the viewer.
  // `pendingNote` carries the item id with the text so a write that is
  // still queued when the viewer steps to the next file lands on the file
  // it was typed for.
  // Typed date correction. The timestamp chip over the image doubles as
  // its entry point — clicking it swaps the text for the segmented field —
  // so the viewer keeps a way to correct a date by hand without a
  // permanently visible form field under the image (dragging the tile on
  // the timeline remains the other way).
  const [dateDraft, setDateDraft] = useState("");
  const [dateEditing, setDateEditing] = useState(false);
  const dateEditorRef = useRef<HTMLDivElement | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const noteSaveTimer = useRef<number | null>(null);
  const pendingNote = useRef<{ id: string; text: string } | null>(null);

  async function saveDisplayName() {
    if (!viewerItem) return;
    const next = nameDraft.trim() || null;
    try {
      await invoke("update_display_name", { id: viewerItem.id, displayName: nameDraft });
      setItems((prev) => prev.map((i) => (i.id === viewerItem.id ? { ...i, display_name: next } : i)));
      // Keep the open viewer's own copy in step, the way saveDate does —
      // otherwise stepping away and back would show the pre-rename name.
      setViewerItem((v) => (v && v.id === viewerItem.id ? { ...v, display_name: next } : v));
      setNameEditing(false);
      setNameError(false);
    } catch {
      // Surfaced rather than swallowed: the user pressed a button labelled
      // "confirm", so silence would read as success. Editing stays open so
      // the typed name isn't lost and can be retried.
      setNameError(true);
    }
  }

  function cancelRename() {
    setNameDraft(viewerItem ? effectiveName(viewerItem) : "");
    setNameEditing(false);
    setNameError(false);
  }

  // Focus the first segment as soon as the editor replaces the chip, so a
  // single click on the timestamp is enough to start typing.
  useEffect(() => {
    if (!dateEditing) return;
    dateEditorRef.current?.querySelector<HTMLInputElement>(".dt-input__field")?.focus();
  }, [dateEditing]);

  function startDateEdit() {
    if (!viewerItem) return;
    setDateDraft(toDatetimeLocalValue(viewerItem.resolved_timestamp));
    setDateEditing(true);
  }

  async function saveDate(committed: string) {
    setDateEditing(false);
    if (!viewerItem) return;
    const iso = fromDatetimeLocalValue(committed);
    if (!iso) {
      // Unreachable as long as the field keeps handing out well-formed
      // values — logged rather than swallowed, because the symptom of the
      // bug this replaced was a date edit vanishing without a trace.
      invoke("debug_log", { message: `saveDate: unparseable value from the date field: ${committed}` }).catch(
        () => {},
      );
      return;
    }
    if (iso === viewerItem.resolved_timestamp) return;
    // Captured before the await: the viewer may have moved on to the next
    // file by the time the save returns, and the new date belongs to this one.
    const id = viewerItem.id;
    try {
      await invoke("update_timestamp", { id, timestamp: iso });
      setItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, resolved_timestamp: iso, timestamp_source: "manual" } : i)),
      );
      setViewerItem((v) => (v && v.id === id ? { ...v, resolved_timestamp: iso, timestamp_source: "manual" } : v));
    } catch (e) {
      showToast(typeof e === "string" ? e : t("viewer.dateSaveFailed"));
    }
  }

  async function saveNote(id: string, text: string) {
    const next = text.trim() || null;
    try {
      await invoke("update_note", { id, note: text });
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, note: next } : i)));
      setViewerItem((v) => (v && v.id === id ? { ...v, note: next } : v));
    } catch {
      // Nothing to surface: the user never pressed a confirm button, so
      // the field simply won't have persisted — same as saveDate.
    }
  }

  /// Writes a queued note immediately. Called before the viewer shows
  /// another file and when it closes, so the debounce can never swallow
  /// the last few characters.
  function flushNote() {
    if (noteSaveTimer.current !== null) {
      window.clearTimeout(noteSaveTimer.current);
      noteSaveTimer.current = null;
    }
    const pending = pendingNote.current;
    pendingNote.current = null;
    if (pending) void saveNote(pending.id, pending.text);
  }

  function handleNoteChange(text: string) {
    if (!viewerItem) return;
    setNoteDraft(text);
    pendingNote.current = { id: viewerItem.id, text };
    if (noteSaveTimer.current !== null) window.clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = window.setTimeout(() => {
      noteSaveTimer.current = null;
      const pending = pendingNote.current;
      pendingNote.current = null;
      if (pending) void saveNote(pending.id, pending.text);
    }, 500);
  }

  return {
    nameDraft,
    setNameDraft,
    nameEditing,
    setNameEditing,
    nameError,
    setNameError,
    dateDraft,
    setDateDraft,
    dateEditing,
    setDateEditing,
    dateEditorRef,
    noteDraft,
    setNoteDraft,
    saveDisplayName,
    cancelRename,
    startDateEdit,
    saveDate,
    flushNote,
    handleNoteChange,
  };
}

export type ViewerEdits = ReturnType<typeof useViewerEdits>;
