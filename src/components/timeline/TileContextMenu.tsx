import type { RefObject } from "react";
import type { ItemInfo } from "../../types";
import { t } from "../../i18n";
import type { DiaryRequest } from "../DiaryDialog";
import RevealInFolderItems from "../filebrowser/RevealInFolderItems";
import SendToProjectItems from "../filebrowser/SendToProjectItems";

export interface ContextMenuState {
  item: ItemInfo;
  x: number;
  y: number;
}

interface Props {
  menuRef: RefObject<HTMLDivElement | null>;
  menu: ContextMenuState;
  selectedCount: number;
  onDiaryRequest?: (request: DiaryRequest) => void;
  onSendSelection: () => void;
  onOpenExternally: (item: ItemInfo) => void;
  onRotate: (item: ItemInfo, delta: number) => void;
  onRemove: (item: ItemInfo) => void;
  onClose: () => void;
}

/// The right-click menu of a tile (on the timeline, in a stack or a cluster).
export default function TileContextMenu({
  menuRef,
  menu,
  selectedCount,
  onDiaryRequest,
  onSendSelection,
  onOpenExternally,
  onRotate,
  onRemove,
  onClose,
}: Props) {
  return (
    <div ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(ev) => ev.stopPropagation()}>
      {menu.item.file_type === "diary" ? (
        <>
          <button
            className="context-menu__item"
            onClick={() => {
              onDiaryRequest?.({ entry: menu.item, edit: true });
              onClose();
            }}
          >
            ✏️ {t("diary.edit")}
          </button>
          <button className="context-menu__item context-menu__item--danger" onClick={() => onRemove(menu.item)}>
            🗑 {t("timeline.remove")}
          </button>
        </>
      ) : (
        <>
          {selectedCount > 0 && (
            <>
              <button
                className="context-menu__item"
                onClick={() => {
                  onSendSelection();
                  onClose();
                }}
              >
                🔧 {selectedCount} {t("timeline.selectionEditButton")}
              </button>
              <div className="context-menu__divider" />
            </>
          )}
          <button
            className="context-menu__item"
            onClick={() => {
              onOpenExternally(menu.item);
              onClose();
            }}
          >
            ↗ {t("timeline.openExternally")}
          </button>
          <RevealInFolderItems itemId={menu.item.id} onDone={onClose} />
          {menu.item.file_type === "image" && (
            <>
              <button className="context-menu__item" onClick={() => onRotate(menu.item, -90)}>
                ↺ {t("timeline.rotateLeft")}
              </button>
              <button className="context-menu__item" onClick={() => onRotate(menu.item, 90)}>
                ↻ {t("timeline.rotateRight")}
              </button>
              <button className="context-menu__item" onClick={() => onRotate(menu.item, 180)}>
                ⟲ {t("timeline.rotate180")}
              </button>
            </>
          )}
          <SendToProjectItems paths={[menu.item.stored_path]} onDone={onClose} />
          <button className="context-menu__item context-menu__item--danger" onClick={() => onRemove(menu.item)}>
            🗑 {t("timeline.remove")}
          </button>
        </>
      )}
    </div>
  );
}
