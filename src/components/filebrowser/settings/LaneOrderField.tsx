import { useState } from "react";
import { t } from "../../../i18n";
import { SETTING_KEYS } from "../../../types";
import { DEFAULT_LANE_STACK, KIND_LANE_ICON, KIND_LANE_LABEL_KEY, type KindLane } from "../../../utils/fileKindLane";
import PreferencesRow from "./PreferencesRow";
import { useSettings } from "./SettingsContext";

/// The lane order, as the stack of lanes it describes.
///
/// A list of four rows read top-to-bottom *is* the preview — each row
/// carries the category's glyph, its name and a few stand-in tiles, so the
/// control shows the thing it configures rather than describing it. Rows
/// move by drag and by the two arrow buttons: the buttons are not a
/// fallback for mouse users but the only way to do this from the keyboard,
/// which a drag target cannot offer. `key={lane}` keeps each row's DOM node
/// with its category across a move, so focus travels with the button that
/// was just pressed instead of jumping to whatever moved into that slot.
export default function LaneOrderField() {
  const { settings, onChange } = useSettings();
  const order: KindLane[] = settings.laneOrder;
  const [dragLane, setDragLane] = useState<KindLane | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  /// Spoken by the live region after a move. Without it a keyboard user
  /// gets no feedback at all: the button they are focused on looks
  /// identical before and after, only its surroundings changed.
  const [announcement, setAnnouncement] = useState("");

  const isDefault = order.every((lane, index) => lane === DEFAULT_LANE_STACK[index]);

  function apply(next: KindLane[], moved: KindLane) {
    const position = next.indexOf(moved) + 1;
    setAnnouncement(
      t("settings.laneOrderPosition")
        .replace("{lane}", t(KIND_LANE_LABEL_KEY[moved]))
        .replace("{pos}", String(position))
        .replace("{total}", String(next.length)),
    );
    onChange({ laneOrder: next });
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [lane] = next.splice(from, 1);
    next.splice(to, 0, lane);
    apply(next, lane);
  }

  function dropOn(index: number) {
    const from = dragLane ? order.indexOf(dragLane) : -1;
    setDragLane(null);
    setDropIndex(null);
    if (from >= 0) move(from, index);
  }

  return (
    <PreferencesRow
      label={t("settings.laneOrder")}
      hint={t("settings.laneOrderHint")}
      scopeKeys={[SETTING_KEYS.laneOrder]}
      stacked
      control={
        <>
          <ol className="settings-lanes">
            {order.map((lane, index) => (
              <li
                key={lane}
                className={
                  "settings-lane" +
                  (dragLane === lane ? " settings-lane--dragging" : "") +
                  (dropIndex === index && dragLane !== lane ? " settings-lane--drop" : "")
                }
                draggable
                onDragStart={(ev) => {
                  setDragLane(lane);
                  // WebKitGTK only starts a drag once the event carries data;
                  // without this the row would simply never lift off, leaving
                  // the arrow buttons as the only way to reorder.
                  ev.dataTransfer.setData("text/plain", lane);
                  ev.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragLane(null);
                  setDropIndex(null);
                }}
                onDragOver={(ev) => {
                  // Without preventDefault the browser refuses the drop and the
                  // row would snap back however far it was dragged.
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = "move";
                  setDropIndex(index);
                }}
                onDrop={(ev) => {
                  ev.preventDefault();
                  dropOn(index);
                }}
              >
                <span className="settings-lane__grip" aria-hidden="true">
                  ⠿
                </span>
                <span className="settings-lane__icon" aria-hidden="true">
                  {KIND_LANE_ICON[lane]}
                </span>
                <span className="settings-lane__label">{t(KIND_LANE_LABEL_KEY[lane])}</span>
                <span className="settings-lane__tiles" aria-hidden="true">
                  <span className="settings-lane__tile" />
                  <span className="settings-lane__tile" />
                  <span className="settings-lane__tile" />
                </span>
                <span className="settings-lane__buttons">
                  <button
                    type="button"
                    className="settings-lane__btn"
                    onClick={() => move(index, index - 1)}
                    disabled={index === 0}
                    aria-label={`${t(KIND_LANE_LABEL_KEY[lane])}: ${t("settings.laneMoveUp")}`}
                    title={t("settings.laneMoveUp")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="settings-lane__btn"
                    onClick={() => move(index, index + 1)}
                    disabled={index === order.length - 1}
                    aria-label={`${t(KIND_LANE_LABEL_KEY[lane])}: ${t("settings.laneMoveDown")}`}
                    title={t("settings.laneMoveDown")}
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="settings-lanes__foot">
            <button
              type="button"
              className="settings-lanes__reset"
              onClick={() => apply([...DEFAULT_LANE_STACK], DEFAULT_LANE_STACK[0])}
              disabled={isDefault}
            >
              {t("settings.laneOrderReset")}
            </button>
            <span className="settings-lanes__live" role="status" aria-live="polite">
              {announcement}
            </span>
          </div>
        </>
      }
    />
  );
}
