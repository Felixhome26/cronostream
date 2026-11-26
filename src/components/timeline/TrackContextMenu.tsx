import type { RefObject } from "react";
import { t } from "../../i18n";
import type { ClipboardImage } from "../../utils/clipboardImage";
import type { DiaryRequest } from "../DiaryDialog";

export interface TrackMenuState {
  x: number;
  y: number;
  iso: string;
  image: ClipboardImage | null;
}

interface Props {
  menuRef: RefObject<HTMLDivElement | null>;
  menu: TrackMenuState;
  onDiaryRequest: (request: DiaryRequest) => void;
  onClose: () => void;
}

/// The right-click menu of the empty track: a diary entry at that date, and
/// pasting an image from the clipboard when there is one.
export default function TrackContextMenu({ menuRef, menu, onDiaryRequest, onClose }: Props) {
  return (
    <div ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(ev) => ev.stopPropagation()}>
      <button
        className="context-menu__item"
        onClick={() => {
          onDiaryRequest({ entry: null, timestamp: menu.iso });
          onClose();
        }}
      >
        📔 {t("diary.menuAdd")}
      </button>
      {menu.image && (
        <button
          className="context-menu__item"
          onClick={() => {
            onDiaryRequest({ entry: null, timestamp: menu.iso, image: menu.image, chooseImageTarget: true });
            onClose();
          }}
        >
          📋 {t("diary.menuPasteClipboard")}
        </button>
      )}
    </div>
  );
}
