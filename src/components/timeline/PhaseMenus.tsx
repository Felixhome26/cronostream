import type { RefObject } from "react";
import { createPortal } from "react-dom";
import type { PhaseGroupView, PhaseView } from "../../types";
import { t } from "../../i18n";
import { formatDay } from "../../utils/phases";
import type { PhaseRowPhase } from "../../utils/phaseLayout";
import PhaseColorPopup from "../PhaseColorPopup";
import { VisibilityEye } from "../PhaseIcons";

/// What the hover popover shows and where the bar's visible part sits on
/// screen (viewport px) — fixed when it opens, it does not follow the mouse.
export interface PhasePopoverState {
  entry: PhaseRowPhase;
  clipped: boolean;
  anchor: { left: number; right: number; top: number; bottom: number };
}

/// The right-click menu of a phase bar. `mode` swaps the entries for the
/// rename field or the colour popup in place, at the same spot.
export interface PhaseMenuState {
  entry: PhaseRowPhase;
  x: number;
  y: number;
  mode: "menu" | "rename" | "color";
}

/// The quick menu left of the phase band: one eye per Themenbereich.
export function PhaseGroupMenu({
  menuRef,
  at,
  groups,
  onToggle,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  at: { x: number; y: number };
  groups: PhaseGroupView[];
  onToggle: (group: PhaseGroupView) => void;
}) {
  return (
    <div ref={menuRef} className="context-menu timeline__group-menu" style={{ left: at.x, top: at.y }} onClick={(ev) => ev.stopPropagation()}>
      {groups.map((group) => (
        <button key={group.id} className="context-menu__item timeline__group-menu-item" onClick={() => onToggle(group)}>
          <VisibilityEye state={group.visibility} />
          <span>{group.name}</span>
        </button>
      ))}
    </div>
  );
}

/// The right-click menu of a phase bar: rename, colour, hide, remove.
export function PhaseBarMenu({
  menuRef,
  menu,
  setMenu,
  renameDraft,
  setRenameDraft,
  palette,
  onCommand,
  onRename,
  onRecolor,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  menu: PhaseMenuState;
  setMenu: (menu: PhaseMenuState | null) => void;
  renameDraft: string;
  setRenameDraft: (draft: string) => void;
  palette: string[];
  onCommand: (command: string, args: Record<string, unknown>, doneToast: string | null) => void;
  onRename: (phase: PhaseView, title: string) => void;
  onRecolor: (phase: PhaseView, color: string) => void;
}) {
  return (
    <div
      ref={menuRef}
      className={menu.mode === "color" ? "phase-menu-color" : "context-menu"}
      style={{ left: menu.x, top: menu.y }}
      onClick={(ev) => ev.stopPropagation()}
    >
      {menu.mode === "menu" && (
        <>
          <div className="context-menu__label">{menu.entry.phase.title}</div>
          <button
            className="context-menu__item"
            onClick={() => {
              setRenameDraft(menu.entry.phase.title);
              setMenu({ ...menu, mode: "rename" });
            }}
          >
            ✏️ {t("phases.menu.rename")}
          </button>
          <button className="context-menu__item" onClick={() => setMenu({ ...menu, mode: "color" })}>
            🎨 {t("phases.menu.color")}
          </button>
          <button
            className="context-menu__item"
            onClick={() => onCommand("set_phase_visibility", { id: menu.entry.phase.id, visible: false }, t("phases.toast.hidden"))}
          >
            🙈 {t("phases.hidePhase")}
          </button>
          <div className="context-menu__divider" />
          <button
            className="context-menu__item context-menu__item--danger"
            onClick={() => onCommand("remove_phase", { id: menu.entry.phase.id }, t("phases.toast.removed"))}
          >
            🗑 {t("phases.removePhase")}
          </button>
        </>
      )}
      {menu.mode === "rename" && (
        <form
          className="phase-menu__rename"
          onSubmit={(ev) => {
            ev.preventDefault();
            onRename(menu.entry.phase, renameDraft);
          }}
        >
          <input
            className="phases-input"
            value={renameDraft}
            autoFocus
            spellCheck={false}
            aria-label={t("phases.phaseTitle")}
            onFocus={(ev) => ev.target.select()}
            onChange={(ev) => setRenameDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.stopPropagation();
                setMenu(null);
              }
            }}
          />
          <button type="submit" className="btn btn--primary" disabled={!renameDraft.trim()}>
            {t("phases.apply")}
          </button>
        </form>
      )}
      {menu.mode === "color" && (
        <PhaseColorPopup
          palette={palette}
          value={menu.entry.phase.color}
          onPick={(color) => onRecolor(menu.entry.phase, color)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/// "↩ Zurück": back to the view before a phase zoom or a jump out of the
/// detail view. Placed beside the file it jumped to when `at` is set.
export function PhaseReturnChip({
  at,
  label,
  onClick,
}: {
  at: { x: number; y: number } | null;
  label: string | null;
  onClick: () => void;
}) {
  return (
    <button
      className={"timeline__phase-return" + (at ? " timeline__phase-return--beside" : "")}
      style={at ? { left: at.x, top: at.y } : undefined}
      onClick={onClick}
      title={label ? t("timeline.viewerReturnHint") : t("timeline.phaseReturnHint")}
    >
      ↩ {label ?? t("timeline.phaseReturn")} <kbd>Esc</kbd>
    </button>
  );
}

/// The hover popover of a phase bar, portalled to the body so no clipping
/// container cuts it off. Positioned by the timeline through `elRef`.
export function PhasePopover({ popover, elRef }: { popover: PhasePopoverState; elRef: RefObject<HTMLDivElement | null> }) {
  return createPortal(
    <div className="phase-popover" ref={elRef} role="tooltip">
      <span className="phase-popover__group">{popover.entry.groupName}</span>
      <span className="phase-popover__title">
        <span className="phase-popover__swatch" style={{ backgroundColor: popover.entry.phase.color }} />
        {popover.entry.phase.title}
      </span>
      <span className="phase-popover__range">
        {formatDay(popover.entry.phase.startDate)} – {formatDay(popover.entry.phase.endDate)}
        {popover.entry.phase.ongoing && ` · ${t("phases.ongoing")}`}
      </span>
      {popover.clipped && <span className="phase-popover__note">{t("timeline.phaseClipped")}</span>}
    </div>,
    document.body,
  );
}
