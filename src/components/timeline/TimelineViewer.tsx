import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ItemInfo, ViewerNavType } from "../../types";
import { t, timestampSourceLabel } from "../../i18n";
import type { useFileDragOut } from "../../hooks/useFileDragOut";
import {
  buildEmailSrcDoc,
  emailSenderAddress,
  emailSenderName,
  formatAttachmentSize,
  formatMetaDate,
  formatMetaSize,
  isSpreadsheetFile,
} from "../../utils/timeline/itemText";
import AudioPlayer from "../AudioPlayer";
import VideoPlayer from "../VideoPlayer";
import RotatedImage from "../RotatedImage";
import WildcardIcon from "../WildcardIcon";
import SegmentedDateTimeInput from "../SegmentedDateTimeInput";
import type { ViewerEdits } from "./useViewerEdits";

export interface ViewerMedia {
  /// Full image, or the media server URL of audio/video; null while loading.
  dataUrl: string | null;
  /// Extracted text of a document or the plain-text body of a mail.
  text: string | null;
  emailHtml: string | null;
  emailRecipients: { to: string[]; cc: string[] } | null;
  emailAttachments: { index: number; name: string; size: number }[];
  /// The timeline's thumbnail, shown for documents with a rendered page.
  thumbUrl: string | undefined;
}

/// The image broken out of the card (scrolled into): see the freed zoom in Timeline.
export interface ViewerFreedZoom {
  active: boolean;
  frameStyle: CSSProperties;
  dragging: boolean;
  onCollapse: () => void;
  onWheel: (ev: ReactWheelEvent<HTMLDivElement>) => void;
  onStartDrag: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  onNaturalSize: (size: { w: number; h: number }) => void;
}

/// The viewer's own step-through type filter (popover at the top left).
export interface ViewerNavFilter {
  active: ViewerNavType[];
  /// The open file's own type: always on, its toggle is locked.
  currentType: ViewerNavType;
  onToggle: (type: ViewerNavType) => void;
  onAll: () => void;
}

const NAV_FILTER_TYPES: { type: ViewerNavType; labelKey: string }[] = [
  { type: "image", labelKey: "timeline.laneImages" },
  { type: "video", labelKey: "timeline.laneVideos" },
  { type: "audio", labelKey: "timeline.laneAudios" },
  { type: "document", labelKey: "timeline.laneDocuments" },
];

function NavFilterPopover({ filter }: { filter: ViewerNavFilter }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Escape closes the popover first; capture + stopImmediatePropagation
  // keeps the timeline's own Escape handler from also leaving the viewer.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const allOn = filter.active.length === NAV_FILTER_TYPES.length;
  return (
    <div className="viewer-navfilter" ref={rootRef} onClick={(ev) => ev.stopPropagation()}>
      <button
        type="button"
        className={"viewer-navfilter__btn" + (open ? " viewer-navfilter__btn--open" : "")}
        onClick={() => setOpen((o) => !o)}
        onMouseUp={(ev) => ev.currentTarget.blur()}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t("timeline.navFilter")}
        title={t("timeline.navFilter")}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          <path d="M3 5h18l-7 8.5V20l-4-2v-4.5z" />
        </svg>
      </button>
      {open && (
        <div className="viewer-navfilter__pop" role="group" aria-label={t("timeline.navFilter")}>
          <div className="viewer-navfilter__title">{t("timeline.navFilterTitle")}</div>
          <button
            type="button"
            className={"viewer-navfilter__chip" + (allOn ? " viewer-navfilter__chip--on" : "")}
            onClick={filter.onAll}
            onMouseUp={(ev) => ev.currentTarget.blur()}
          >
            {t("timeline.navFilterAll")}
          </button>
          {NAV_FILTER_TYPES.map(({ type, labelKey }) => {
            const on = filter.active.includes(type);
            const locked = type === filter.currentType;
            return (
              <button
                key={type}
                type="button"
                className={"viewer-navfilter__chip" + (on ? " viewer-navfilter__chip--on" : "")}
                disabled={locked}
                title={locked ? t("timeline.navFilterLocked") : undefined}
                onClick={() => filter.onToggle(type)}
                onMouseUp={(ev) => ev.currentTarget.blur()}
              >
                <span>{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Props {
  item: ItemInfo;
  media: ViewerMedia;
  freed: ViewerFreedZoom;
  edits: ViewerEdits;
  dragOut: ReturnType<typeof useFileDragOut>;
  timestampOverlayEnabled: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (direction: -1 | 1) => void;
  /// Null where the arrows are pinned to a fixed set (search cluster).
  navFilter: ViewerNavFilter | null;
  onLeave: () => void;
  /// Wheel over the card while not zoomed: the timeline counts backward steps towards closing.
  onBackWheel?: (ev: ReactWheelEvent<HTMLDivElement>) => void;
  onContextMenu: (item: ItemInfo, ev: ReactMouseEvent) => void;
  onOpenExternally: (item: ItemInfo) => void;
  onOpenAttachment: (item: ItemInfo, index: number) => void;
  onRemove: (item: ItemInfo) => void;
  noteClusterIds: string[];
  onOpenNoteCluster: (ids: string[]) => void;
}

/// The detail view over the timeline: one file large, with its name, date
/// and note, arrows to the neighbours, and the image's break-out zoom.
/// Moved out of Timeline.tsx unchanged; all of its state stays with the
/// timeline (see useViewerEdits for the edits).
export default function TimelineViewer({
  item,
  media,
  freed,
  edits,
  dragOut,
  timestampOverlayEnabled,
  hasPrev,
  hasNext,
  onStep,
  navFilter,
  onLeave,
  onBackWheel,
  onContextMenu,
  onOpenExternally,
  onOpenAttachment,
  onRemove,
  noteClusterIds,
  onOpenNoteCluster,
}: Props) {
  const { dataUrl, text, emailHtml, emailRecipients, emailAttachments, thumbUrl } = media;
  const {
    nameDraft,
    setNameDraft,
    nameEditing,
    setNameEditing,
    nameError,
    setNameError,
    dateDraft,
    setDateDraft,
    dateEditing,
    dateEditorRef,
    noteDraft,
    saveDisplayName,
    cancelRename,
    startDateEdit,
    saveDate,
    flushNote,
    handleNoteChange,
  } = edits;

  // The editable date chip overlaid on the viewer's media. Extracted so it
  // can be anchored two different ways: for every other type it's a sibling
  // positioned against the whole .viewer-card__media box, but a video has
  // its own always-visible control bar sitting in flow below the picture —
  // anchoring it there the same way left the chip floating in that mostly
  // empty control-bar strip instead of over the video like it sits over a
  // photo. For video it's rendered inside a wrapper around just the frame
  // instead (see the video branch below), same markup either way.
  function renderTimestampChip() {
    return (
      <div
        className={
          "viewer-card__timestamp" +
          (timestampOverlayEnabled ? "" : " viewer-card__timestamp--on-hover") +
          (dateEditing ? " viewer-card__timestamp--editing" : "")
        }
        ref={dateEditorRef}
        onClick={(ev) => {
          ev.stopPropagation();
          if (!dateEditing) startDateEdit();
        }}
        title={dateEditing ? undefined : t("timeline.editDateHint")}
      >
        {dateEditing ? (
          <SegmentedDateTimeInput
            className="viewer-card__date-input"
            value={dateDraft}
            onChange={setDateDraft}
            onCommit={saveDate}
            sourceLabel={timestampSourceLabel(item.timestamp_source)}
          />
        ) : (
          formatMetaDate(item.resolved_timestamp)
        )}
      </div>
    );
  }

  return (
    <div className="viewer-overlay" onClick={freed.active ? freed.onCollapse : onLeave} onWheel={freed.active ? freed.onWheel : onBackWheel}>
      {freed.active && dataUrl && (
        // The freed layer replaces the framed card entirely (nav
        // arrows, close button, rename/date fields all hidden) — only
        // the image itself and the dark backdrop remain, per how a
        // "break out to fullscreen" zoom is meant to look.
        <div
          className={"viewer-freed__frame" + (freed.dragging ? " viewer-freed__frame--dragging" : "")}
          style={freed.frameStyle}
          onClick={(ev) => ev.stopPropagation()}
          onMouseDown={(ev) => (ev.altKey ? dragOut.onMouseDown(ev) : freed.onStartDrag(ev))}
          onClickCapture={dragOut.onClickCapture}
        >
          <RotatedImage src={dataUrl} alt="" rotation={item.rotation} itemKey={item.id} />
        </div>
      )}
      {!freed.active && (
        <>
          {hasPrev && (
            <button
              className="viewer-nav-arrow viewer-nav-arrow--left"
              onClick={(ev) => {
                ev.stopPropagation();
                onStep(-1);
              }}
              aria-label={t("timeline.previous")}
            >
              ‹
            </button>
          )}
          {hasNext && (
            <button
              className="viewer-nav-arrow viewer-nav-arrow--right"
              onClick={(ev) => {
                ev.stopPropagation();
                onStep(1);
              }}
              aria-label={t("timeline.next")}
            >
              ›
            </button>
          )}
          {/* Clicking anywhere in the card (including the media itself)
              closes the viewer — only the controls below opt back out via
              stopPropagation, since they need their own clicks. */}
          <div className="viewer-card">
            {navFilter && <NavFilterPopover filter={navFilter} />}
            <button
              className="icon-btn viewer-card__close"
              onClick={(ev) => {
                ev.stopPropagation();
                onLeave();
              }}
              aria-label={t("start.cancel")}
            >
              ✕
            </button>
            <div className="viewer-card__media" {...dragOut} onContextMenu={(ev) => onContextMenu(item, ev)} onWheel={freed.onWheel}>
              {item.file_type === "image" &&
                (dataUrl ? (
                  <RotatedImage src={dataUrl} alt="" rotation={item.rotation} itemKey={item.id} onNaturalSize={freed.onNaturalSize} />
                ) : (
                  <span className="timeline-tile__icon timeline-tile__icon--large">🖼️</span>
                ))}
              {item.file_type === "audio" &&
                (dataUrl ? (
                  <AudioPlayer src={dataUrl} autoPlay className="viewer-card__audio" />
                ) : (
                  <span className="timeline-tile__icon timeline-tile__icon--large">🎧</span>
                ))}
              {item.file_type === "video" &&
                (dataUrl ? (
                  <VideoPlayer src={dataUrl} autoPlay className="viewer-card__video" frameOverlay={renderTimestampChip()} />
                ) : (
                  <span className="timeline-tile__icon timeline-tile__icon--large">🎬</span>
                ))}
              {item.file_type === "document" && isSpreadsheetFile(item) ? (
                <div className="viewer-card__external-stack">
                  <span className="timeline-tile__icon timeline-tile__icon--large">📊</span>
                  <button
                    type="button"
                    className="btn btn--primary viewer-card__open-external"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpenExternally(item);
                    }}
                  >
                    {t("timeline.openExternally")}
                  </button>
                </div>
              ) : item.file_type === "document" && !item.thumbnail_path ? (
                <div className="viewer-card__text-stack" onClick={(ev) => ev.stopPropagation()}>
                  <div className="viewer-card__text" data-text-selectable>
                    {text == null ? (
                      <span className="timeline-tile__icon timeline-tile__icon--large">📄</span>
                    ) : text === "" ? (
                      <span className="viewer-card__text-empty">{t("timeline.noTextExtracted")}</span>
                    ) : (
                      text
                    )}
                  </div>
                  <button type="button" className="btn btn--primary viewer-card__open-external" onClick={() => onOpenExternally(item)}>
                    {t("timeline.openExternally")}
                  </button>
                </div>
              ) : (
                item.file_type === "document" && (
                  <div className="viewer-card__external-stack">
                    {thumbUrl ? <img src={thumbUrl} alt="" /> : <span className="timeline-tile__icon timeline-tile__icon--large">📄</span>}
                    <button
                      type="button"
                      className="btn btn--primary viewer-card__open-external"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onOpenExternally(item);
                      }}
                    >
                      {t("timeline.openExternally")}
                    </button>
                  </div>
                )
              )}
              {item.file_type === "other" && (
                <div className="viewer-card__external-stack">
                  <div className="viewer-card__symbol-frame">
                    <WildcardIcon className="wildcard-icon--detail" />
                    {/* Anchored to the symbol, not the media box, so it
                        sits above the button instead of covering it. */}
                    {renderTimestampChip()}
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary viewer-card__open-external"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpenExternally(item);
                    }}
                  >
                    {t("timeline.openExternally")}
                  </button>
                </div>
              )}
              {item.file_type === "email" && (
                <div className="viewer-card__email" data-text-selectable onClick={(ev) => ev.stopPropagation()}>
                  <div className="viewer-card__email-header">
                    <div className="viewer-card__email-subject">
                      <span className="viewer-card__email-icon">✉️</span>
                      {item.email_subject ?? item.original_filename}
                    </div>
                    <dl className="viewer-card__email-fields">
                      {item.email_sender && (
                        <>
                          <dt>{t("viewer.emailFrom")}</dt>
                          <dd>
                            <strong>{emailSenderName(item.email_sender)}</strong>
                            {emailSenderAddress(item.email_sender) && (
                              <span className="viewer-card__email-addr"> &lt;{emailSenderAddress(item.email_sender)}&gt;</span>
                            )}
                          </dd>
                        </>
                      )}
                      {emailRecipients && emailRecipients.to.length > 0 && (
                        <>
                          <dt>{t("viewer.emailTo")}</dt>
                          <dd>{emailRecipients.to.join(", ")}</dd>
                        </>
                      )}
                      {emailRecipients && emailRecipients.cc.length > 0 && (
                        <>
                          <dt>{t("viewer.emailCc")}</dt>
                          <dd>{emailRecipients.cc.join(", ")}</dd>
                        </>
                      )}
                      <dt>{t("viewer.emailDate")}</dt>
                      <dd>{formatMetaDate(item.resolved_timestamp)}</dd>
                    </dl>
                  </div>
                  <div className="viewer-card__email-main">
                    <div className="viewer-card__email-body">
                      {emailHtml != null ? (
                        <iframe
                          // allow-same-origin only so the parent can hook link
                          // clicks; scripts stay blocked (no allow-scripts).
                          sandbox="allow-same-origin"
                          onLoad={(e) => {
                            const doc = e.currentTarget.contentDocument;
                            if (!doc) return;
                            doc.addEventListener("click", (ev) => {
                              const a = (ev.target as Element | null)?.closest?.("a");
                              const href = a?.getAttribute("href");
                              if (!href || href.startsWith("#")) return;
                              ev.preventDefault();
                              if (/^(https?:|mailto:|tel:)/i.test(href)) openUrl(href).catch(() => {});
                            });
                          }}
                          srcDoc={buildEmailSrcDoc(emailHtml)}
                          className="viewer-card__email-frame"
                          // Inline, not just the class: an <iframe> is a
                          // replaced element that defaults to 300x150px
                          // regardless of a flex-column ancestor chain in
                          // some engines unless its own box is pinned
                          // explicitly — this guarantees it actually fills
                          // `.viewer-card__email-body` instead of shrinking
                          // to a small patch lost in the dark surroundings.
                          style={{ display: "block", width: "100%", height: "100%", border: "none" }}
                          title={item.email_subject ?? item.original_filename}
                        />
                      ) : text == null ? (
                        <span className="timeline-tile__icon timeline-tile__icon--large">✉️</span>
                      ) : text === "" ? (
                        <span className="viewer-card__text-empty">{t("timeline.noTextExtracted")}</span>
                      ) : (
                        <div className="viewer-card__text">{text}</div>
                      )}
                    </div>
                    {emailAttachments.length > 0 && (
                      <aside className="viewer-card__email-attachments">
                        <h3 className="viewer-card__email-attachments-title">
                          {t("timeline.attachments")} ({emailAttachments.length})
                        </h3>
                        <ul className="viewer-card__email-attachments-list">
                          {emailAttachments.map((att) => (
                            <li key={att.index}>
                              <button
                                type="button"
                                className="viewer-card__email-attachment"
                                title={t("timeline.openExternally")}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  onOpenAttachment(item, att.index);
                                }}
                              >
                                <span className="viewer-card__email-attachment-icon">📎</span>
                                <span className="viewer-card__email-attachment-name">{att.name}</span>
                                <span className="viewer-card__email-attachment-size">{formatAttachmentSize(att.size)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </aside>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary viewer-card__open-external"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpenExternally(item);
                    }}
                  >
                    {t("timeline.openExternally")}
                  </button>
                </div>
              )}
              {/* Not shown for documents or e-mails: documents get their
                  own inline date field next to the name (see
                  viewer-card__name-date below — their card has no image to
                  overlay this chip on), and e-mails already show their
                  date in the header fields. Not shown here for a loaded
                  video either — it's passed into VideoPlayer's
                  `frameOverlay` instead, so it overlays just the picture
                  and not the control bar below it; a video still falls
                  back to this spot while its data hasn't loaded yet (no
                  control bar there to collide with). Rendered even when
                  the overlay setting is off — then it only appears while
                  the pointer is over the card (see `--on-hover`), so
                  switching the overlay off still means "no permanent chip
                  on the image", not "no way to type a date". */}
              {item.file_type !== "document" &&
                item.file_type !== "email" &&
                item.file_type !== "other" &&
                !(item.file_type === "video" && dataUrl) &&
                renderTimestampChip()}
            </div>
            {item.file_type === "document" && item.original_filename.toLowerCase().endsWith(".doc") && (
              <dl className="viewer-card__meta" onClick={(ev) => ev.stopPropagation()}>
                {formatMetaSize(item.file_size_bytes) && (
                  <>
                    <dt>{t("browser.size")}</dt>
                    <dd>{formatMetaSize(item.file_size_bytes)}</dd>
                  </>
                )}
                {formatMetaDate(item.fs_created_at) && (
                  <>
                    <dt>{t("browser.created")}</dt>
                    <dd>{formatMetaDate(item.fs_created_at)}</dd>
                  </>
                )}
                {formatMetaDate(item.fs_modified_at) && (
                  <>
                    <dt>{t("browser.modified")}</dt>
                    <dd>{formatMetaDate(item.fs_modified_at)}</dd>
                  </>
                )}
              </dl>
            )}
            <div className="viewer-card__name-block" onClick={(ev) => ev.stopPropagation()}>
              <div className="viewer-card__name-row">
                <input
                  className="text-input viewer-card__name-input"
                  value={nameDraft}
                  onChange={(ev) => {
                    setNameDraft(ev.target.value);
                    setNameError(false);
                  }}
                  onFocus={() => setNameEditing(true)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") saveDisplayName();
                    else if (ev.key === "Escape") cancelRename();
                  }}
                  placeholder={item.original_filename}
                  aria-label={t("timeline.rename")}
                />
                {nameEditing && (
                  <button type="button" className="btn btn--primary viewer-card__name-confirm" onClick={saveDisplayName}>
                    {t("timeline.renameConfirm")}
                  </button>
                )}
                {/* Documents have no image to carry the usual timestamp
                    overlay chip (see viewer-card__timestamp above), so
                    their date field lives here instead, right next to the
                    name it's edited alongside. */}
                {item.file_type === "document" && (
                  <div
                    className={"viewer-card__name-date" + (dateEditing ? " viewer-card__name-date--editing" : "")}
                    ref={dateEditorRef}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (!dateEditing) startDateEdit();
                    }}
                    title={dateEditing ? undefined : t("timeline.editDateHint")}
                  >
                    {dateEditing ? (
                      <SegmentedDateTimeInput
                        className="viewer-card__date-input"
                        value={dateDraft}
                        onChange={setDateDraft}
                        onCommit={saveDate}
                        sourceLabel={timestampSourceLabel(item.timestamp_source)}
                      />
                    ) : (
                      formatMetaDate(item.resolved_timestamp)
                    )}
                  </div>
                )}
                <button className="btn--text viewer-card__remove" onClick={() => onRemove(item)}>
                  🗑 {t("timeline.remove")}
                </button>
              </div>
              {nameError && <p className="viewer-card__name-error">{t("timeline.renameFailed")}</p>}
            </div>
            {/* The note. Takes the room the date field used to have: the
                date is already on the image as the timestamp overlay, and
                correcting it by hand stays available by dragging the tile
                on the timeline. */}
            <div className="viewer-card__note-row" onClick={(ev) => ev.stopPropagation()}>
              <span className="viewer-card__note-icon" aria-hidden="true">
                ✏️
              </span>
              <textarea
                className="text-input viewer-card__note-input"
                value={noteDraft}
                onChange={(ev) => handleNoteChange(ev.target.value)}
                onBlur={flushNote}
                placeholder={t("timeline.notePlaceholder")}
                aria-label={t("timeline.note")}
              />
              {/* Shown only once this exact (trimmed) note text is on at
                  least one other file too — a note unique to this file
                  has nothing to cluster into. Hands the whole group off
                  into a temporary cluster card (see openNoteCluster). */}
              {noteClusterIds.length > 1 && (
                <button
                  type="button"
                  className="btn--text viewer-card__note-cluster"
                  title={t("timeline.noteClusterHint")}
                  onClick={() => onOpenNoteCluster(noteClusterIds)}
                >
                  🔗 {t("timeline.noteClusterButton")} ({noteClusterIds.length})
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
