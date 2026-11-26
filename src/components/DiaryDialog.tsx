import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "../busy";
import { t } from "../i18n";
import type { DiaryAttachment, ItemInfo } from "../types";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { readClipboardImage, type ClipboardImage } from "../utils/clipboardImage";
import { formatDateTime, fromDatetimeLocalValue, toDatetimeLocalValue } from "../utils/datetime";
import { suppressGlobalFileDrops } from "../utils/dropSuppression";
import { dropProblem, onFileDrop } from "../utils/fileDrop";
import { mediaUrl } from "../utils/mediaServer";
import SegmentedDateTimeInput from "./SegmentedDateTimeInput";

interface PendingAttachment {
  key: string;
  name: string;
  path?: string;
  dataBase64?: string;
  previewUrl?: string;
}

/// What asks for the dialog: the toolbar button and the timeline's context
/// menu both describe it this way, ProjectShell hosts the dialog itself.
/// What the dialog hands to the timeline to show attachments in the app's own
/// viewer (or a temporary cluster) instead of the default program.
export interface FileViewRequest {
  items: ItemInfo[];
  mode: "cluster" | "viewer";
  openId?: string;
}

const VIEWABLE_KINDS = ["image", "video", "audio"];

export interface DiaryRequest {
  entry: ItemInfo | null;
  timestamp?: string;
  image?: ClipboardImage | null;
  edit?: boolean;
  /// An image from the clipboard that may become a plain image item or a
  /// diary entry — the user is asked which first.
  chooseImageTarget?: boolean;
}

interface Props {
  /// The entry being viewed/edited, `null` for a new one.
  entry: ItemInfo | null;
  /// New entries only: where on the timeline it goes (ISO).
  initialTimestamp?: string;
  /// New entries only: an image already taken from the clipboard.
  initialImage?: ClipboardImage | null;
  /// Existing entries open read-only unless this is set (the tile's pencil).
  startInEdit?: boolean;
  onSaved: () => void;
  onClose: () => void;
  onShowFiles: (request: FileViewRequest) => void;
  onToast: (message: string) => void;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : t("diary.saveError");
}

export default function DiaryDialog({ entry, initialTimestamp, initialImage, startInEdit, onSaved, onClose, onShowFiles, onToast }: Props) {
  const isNew = entry === null;
  const originalText = entry?.diary_text ?? "";
  const originalDate = toDatetimeLocalValue(entry?.resolved_timestamp ?? initialTimestamp ?? new Date().toISOString());

  const [editing, setEditing] = useState(isNew || !!startInEdit);
  const [text, setText] = useState(originalText);
  const [dateDraft, setDateDraft] = useState(originalDate);
  const [existing, setExisting] = useState<DiaryAttachment[]>([]);
  const [existingUrls, setExistingUrls] = useState<Record<string, string>>({});
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingAttachment[]>(() =>
    initialImage ? [{ key: crypto.randomUUID(), name: initialImage.name, dataBase64: initialImage.dataBase64, previewUrl: initialImage.previewUrl }] : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = text !== originalText || dateDraft !== originalDate || removedIds.size > 0 || pending.length > 0;

  // A message from the last "Speichern" refers to what was there then; once
  // the text, date or attachments change it no longer applies (it stayed
  // up after text had been typed).
  useEffect(() => {
    setError(null);
  }, [text, dateDraft, pending, removedIds]);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    invoke<DiaryAttachment[]>("get_diary_attachments", { id: entry.id })
      .then(async (list) => {
        if (cancelled) return;
        setExisting(list);
        const urls: Record<string, string> = {};
        for (const att of list) {
          if (att.file_type === "image") urls[att.id] = await mediaUrl(att.stored_path);
        }
        if (!cancelled) setExistingUrls(urls);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entry]);

  useEffect(() => {
    if (editing) textRef.current?.focus();
  }, [editing]);

  const requestClose = useCallback(() => {
    if (editing && dirty) setConfirmDiscard(true);
    else onClose();
  }, [editing, dirty, onClose]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        requestClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  const addPaths = useCallback((paths: string[]) => {
    const added = paths.map((path) => ({ key: crypto.randomUUID(), name: fileName(path), path }));
    setPending((prev) => [...prev, ...added]);
    // Pictures picked or dropped from disk get the same small preview as a
    // pasted one; until it arrives (or if it can't be made) the card keeps
    // its picture symbol.
    for (const p of added) {
      if (!IMAGE_EXT.test(p.path)) continue;
      invoke<string>("get_file_preview", { path: p.path })
        .then((previewUrl) => setPending((prev) => prev.map((q) => (q.key === p.key ? { ...q, previewUrl } : q))))
        .catch(() => {});
    }
  }, []);

  // Files dropped onto the window belong to this entry while it is open for
  // editing — the main window's import-on-drop is switched off meanwhile.
  // Through a ref, so a new toast callback doesn't re-subscribe the drop.
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  useEffect(() => {
    if (!editing) return;
    const release = suppressGlobalFileDrops();
    const unlisten = onFileDrop((event) => {
      if (event.type === "enter" || event.type === "over") setDragOver(true);
      else if (event.type === "drop") {
        setDragOver(false);
        const problem = dropProblem(event);
        if (problem) toastRef.current(problem);
        if (event.paths.length > 0) addPaths(event.paths);
      } else setDragOver(false);
    });
    return () => {
      release();
      void unlisten.then((un) => un());
    };
  }, [editing, addPaths]);

  // Ctrl+V with an image on the clipboard attaches it. Read through the
  // native clipboard on the keystroke instead of the webview's paste event,
  // which WebKitGTK does not reliably fire for image data. A clipboard that
  // also holds text (copied from a web page, say) pastes that text into the
  // field as usual and attaches nothing.
  useEffect(() => {
    if (!editing) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "v") return;
      void (async () => {
        const hasText = await readText().then((s) => s.length > 0).catch(() => false);
        if (hasText) return;
        const img = await readClipboardImage();
        if (img) {
          setPending((prev) => [...prev, { key: crypto.randomUUID(), name: img.name, dataBase64: img.dataBase64, previewUrl: img.previewUrl }]);
        }
      })();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  async function chooseFiles() {
    const picked = await openDialog({ multiple: true, directory: false });
    if (!picked) return;
    addPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async function pasteFromClipboard() {
    const img = await readClipboardImage();
    if (!img) {
      onToast(t("diary.noClipboardImage"));
      return;
    }
    setPending((prev) => [...prev, { key: crypto.randomUUID(), name: img.name, dataBase64: img.dataBase64, previewUrl: img.previewUrl }]);
  }

  async function save() {
    if (saving) return;
    const timestamp = fromDatetimeLocalValue(dateDraft);
    if (!timestamp) {
      setError(t("diary.invalidDate"));
      return;
    }
    const keptExisting = existing.filter((a) => !removedIds.has(a.id)).length;
    if (!text.trim() && pending.length === 0 && keptExisting === 0) {
      setError(t("diary.emptyError"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await invoke("save_diary_entry", {
        id: entry?.id ?? null,
        text,
        timestamp,
        removeAttachmentIds: Array.from(removedIds),
        addAttachments: pending.map((p) => ({ path: p.path ?? null, name: p.name, data_base64: p.dataBase64 ?? null })),
      });
      onToast(t(isNew ? "diary.addedToast" : "diary.savedToast"));
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  const visibleExisting = existing.filter((a) => !removedIds.has(a.id));
  // Attachments the viewer can show, as stand-in items (they are no rows of
  // `items`, so the id is synthetic and only lives as long as the view).
  const viewableItems: ItemInfo[] = ((): ItemInfo[] => {
    return entry
        ? visibleExisting
            .filter((a) => VIEWABLE_KINDS.includes(a.file_type))
            .map((a) => ({
              id: `diaryatt:${a.id}`,
              original_filename: a.original_filename,
              display_name: null,
              stored_path: a.stored_path,
              thumbnail_path: null,
              file_type: a.file_type,
              resolved_timestamp: entry.resolved_timestamp,
              timestamp_source: entry.timestamp_source,
              import_batch_id: null,
              fs_created_at: null,
              fs_modified_at: null,
              file_size_bytes: null,
              rotation: 0,
              note: null,
              email_subject: null,
              email_sender: null,
              email_date: null,
              diary_text: null,
              attachment_count: 0,
            }))
        : [];
  })();

  return (
    <div className="diary-modal" onMouseDown={(ev) => ev.target === ev.currentTarget && requestClose()}>
      <div
        className={"diary-modal__panel" + (dragOver ? " diary-modal__panel--dragover" : "")}
        onKeyDown={(ev) => {
          if (editing && ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            void save();
          }
        }}
      >
        <div className="diary-modal__header">
          <div className="diary-modal__title">
            📔 {isNew ? t("diary.titleNew") : t("diary.title")}
          </div>
          <div className="diary-modal__header-actions">
            {!editing && (
              <button className="icon-btn" onClick={() => setEditing(true)} title={t("diary.edit")} aria-label={t("diary.edit")}>
                ✏️
              </button>
            )}
            <button className="icon-btn" onClick={requestClose} title={t("record.close")} aria-label={t("record.close")}>
              ✕
            </button>
          </div>
        </div>

        <div className="diary-modal__body">
          <div className="diary-modal__field">
            <span className="diary-modal__label">{t("diary.dateLabel")}</span>
            {editing ? (
              <SegmentedDateTimeInput className="diary-modal__date" value={dateDraft} onChange={setDateDraft} onCommit={() => {}} />
            ) : (
              <span>{formatDateTime(entry!.resolved_timestamp)}</span>
            )}
          </div>

          {editing ? (
            <textarea
              ref={textRef}
              className="text-input diary-modal__text"
              value={text}
              placeholder={t("diary.textPlaceholder")}
              onChange={(ev) => setText(ev.target.value)}
            />
          ) : (
            <div className="diary-modal__text-view">{originalText || <em>{t("diary.noText")}</em>}</div>
          )}

          <div className="diary-modal__label">{t("diary.attachments")}</div>
          {visibleExisting.length === 0 && pending.length === 0 && (
            <div className="diary-modal__hint">{t("diary.noAttachments")}</div>
          )}
          <div className="diary-modal__attachments">
            {visibleExisting.map((att) => (
              <div key={att.id} className="diary-attachment">
                <button
                  className="diary-attachment__open"
                  onClick={() => {
                    const viewable = !editing && viewableItems.find((v) => v.id === `diaryatt:${att.id}`);
                    if (viewable) onShowFiles({ items: viewableItems, mode: "viewer", openId: viewable.id });
                    else void invoke<boolean>("open_path_checked", { path: att.stored_path }).catch(() => onToast(t("diary.openError")));
                  }}
                  title={t("diary.openAttachment")}
                >
                  {existingUrls[att.id] ? <img src={existingUrls[att.id]} alt="" /> : <span className="diary-attachment__icon">📎</span>}
                  <span className="diary-attachment__name">{att.original_filename}</span>
                </button>
                {editing && (
                  <button
                    className="icon-btn diary-attachment__remove"
                    onClick={() => setRemovedIds((prev) => new Set(prev).add(att.id))}
                    title={t("diary.removeAttachment")}
                    aria-label={t("diary.removeAttachment")}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {pending.map((p) => (
              <div key={p.key} className="diary-attachment diary-attachment--new">
                <div className="diary-attachment__open">
                  {p.previewUrl || (p.path && IMAGE_EXT.test(p.path)) ? (
                    p.previewUrl ? <img src={p.previewUrl} alt="" /> : <span className="diary-attachment__icon">🖼️</span>
                  ) : (
                    <span className="diary-attachment__icon">📎</span>
                  )}
                  <span className="diary-attachment__name">{p.name}</span>
                </div>
                <button
                  className="icon-btn diary-attachment__remove"
                  onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
                  title={t("diary.removeAttachment")}
                  aria-label={t("diary.removeAttachment")}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {editing && (
            <div className="diary-modal__attach-actions">
              <button className="btn" onClick={() => void chooseFiles()}>
                📎 {t("diary.addFiles")}
              </button>
              <button className="btn" onClick={() => void pasteFromClipboard()}>
                📋 {t("diary.pasteImage")}
              </button>
              <span className="diary-modal__hint">{t("diary.dropHint")}</span>
            </div>
          )}

          {error && <div className="diary-modal__error">{error}</div>}
        </div>

        <div className="diary-modal__footer">
          {confirmDiscard ? (
            <>
              <span className="diary-modal__hint">{t("diary.discardQuestion")}</span>
              <button className="btn" onClick={() => setConfirmDiscard(false)}>
                {t("diary.keepEditing")}
              </button>
              <button className="btn btn--danger" onClick={onClose}>
                {t("diary.discard")}
              </button>
            </>
          ) : editing ? (
            <>
              <button className="btn" onClick={requestClose} disabled={saving}>
                {t("start.cancel")}
              </button>
              <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
                {t("diary.save")}
              </button>
            </>
          ) : (
            <>
              {viewableItems.length > 1 && (
                <button className="btn" onClick={() => onShowFiles({ items: viewableItems, mode: "cluster" })}>
                  {t("diary.showFiles")}
                </button>
              )}
              <button className="btn" onClick={onClose}>
                {t("record.close")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
