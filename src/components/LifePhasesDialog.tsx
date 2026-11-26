import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "../busy";
import { t } from "../i18n";
import { useToast } from "../ToastContext";
import type {
  PhaseGroupPatch,
  PhaseGroupView,
  PhaseInput,
  PhaseOverlapPair,
  PhasePatch,
  PhaseSaveOutcome,
  PhaseView,
} from "../types";
import { formatDay } from "../utils/phases";
import ToggleSwitch from "./filebrowser/ToggleSwitch";
import PhaseColorPopup from "./PhaseColorPopup";
import { ChevronIcon, DragHandleIcon, TrashIcon, VisibilityEye } from "./PhaseIcons";
import SegmentedDateTimeInput from "./SegmentedDateTimeInput";

interface Props {
  groups: PhaseGroupView[];
  onGroupsChange: Dispatch<SetStateAction<PhaseGroupView[]>>;
  /// Refetches the list — after every write whose result is easier to ask
  /// for than to patch in (sort by start date, the group's derived eye).
  onReload: () => Promise<void>;
  onClose: () => void;
}

/// Clashes the backend refused to save, keyed by the group or phase the
/// edit was made on; the input itself stays as typed.
type Conflicts = Record<string, PhaseOverlapPair[]>;

type SaveResult = "saved" | "overlap" | "failed";

function describePair(pair: PhaseOverlapPair): string {
  const span = (p: PhaseView) => `${p.title} (${formatDay(p.startDate)} – ${formatDay(p.endDate)})`;
  return `${span(pair.first)} ↔ ${span(pair.second)}`;
}

function ConflictMessage({ pairs }: { pairs: PhaseOverlapPair[] }) {
  return (
    <div className="phases-conflict" role="alert">
      <div>{t("phases.overlapRefused")}</div>
      <ul>
        {pairs.map((pair, i) => (
          <li key={i}>{describePair(pair)}</li>
        ))}
      </ul>
    </div>
  );
}

const COLLAPSED_KEY = "cronostream.phasesCollapsed";
const SORT_KEY = "cronostream.phasesSort";

type SortMode = "recent" | "manual";

function loadCollapsed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function loadSortMode(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === "manual" ? "manual" : "recent";
  } catch {
    return "recent";
  }
}

/// Where a Themenbereich lands if dropped at pointer height `y`: the number
/// of the other groups whose middle is above it.
function dropIndex(elements: Map<string, HTMLElement>, groups: PhaseGroupView[], draggedId: string, y: number): number {
  let index = 0;
  for (const group of groups) {
    if (group.id === draggedId) continue;
    const rect = elements.get(group.id)?.getBoundingClientRect();
    if (rect && y > rect.top + rect.height / 2) index++;
  }
  return index;
}

export default function LifePhasesDialog({ groups, onGroupsChange, onReload, onClose }: Props) {
  const showToast = useToast();
  const [palette, setPalette] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<Conflicts>({});
  // Groups with an unsaved new-phase row (see `addPhase`).
  const [draftGroups, setDraftGroups] = useState<Set<string>>(new Set());
  // Just created: its name or title field takes the focus once, on mount.
  const [freshId, setFreshId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; overIndex: number } | null>(null);
  const groupElements = useRef(new Map<string, HTMLElement>());
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode);

  // "recent": the dialog lists the most recently edited Themenbereich first.
  // The stored order (sortIndex, which the timeline follows) is untouched;
  // it is what "manual" shows and what the handles change.
  const shownGroups = useMemo(
    () =>
      sortMode === "manual"
        ? groups
        : [...groups].sort((a, b) => b.lastEditedAt - a.lastEditedAt || a.sortIndex - b.sortIndex),
    [groups, sortMode],
  );

  function setExpanded(id: string, expanded: boolean) {
    setCollapsed((prev) => {
      if (prev.has(id) === !expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // not persisted: the dialog still works, it just forgets next time
      }
      return next;
    });
  }

  function changeSortMode(mode: SortMode) {
    setSortMode(mode);
    try {
      localStorage.setItem(SORT_KEY, mode);
    } catch {
      // see setExpanded
    }
  }

  useEffect(() => {
    invoke<string[]>("get_phase_palette").then(setPalette).catch(() => setPalette([]));
  }, []);

  useEffect(() => {
    function handleKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function setConflict(key: string, pairs: PhaseOverlapPair[] | null) {
    setConflicts((prev) => {
      if (!pairs && !prev[key]) return prev;
      const next = { ...prev };
      if (pairs) next[key] = pairs;
      else delete next[key];
      return next;
    });
  }

  /// Every command goes through here: a refusal (empty title, bad date) is
  /// the backend's own sentence, shown as a toast; null tells the caller to
  /// put its draft back.
  async function call<T>(command: string, args: Record<string, unknown>): Promise<T | null> {
    try {
      return await invoke<T>(command, args);
    } catch (e) {
      showToast(typeof e === "string" ? e : t("phases.saveError"));
      return null;
    }
  }

  /// For commands that return nothing, where a null result cannot tell
  /// "done" from "refused".
  async function run(command: string, args: Record<string, unknown>): Promise<boolean> {
    try {
      await invoke(command, args);
      return true;
    } catch (e) {
      showToast(typeof e === "string" ? e : t("phases.saveError"));
      return false;
    }
  }

  const savedToast = () => showToast(t("phases.toast.saved"));

  async function createGroup() {
    let group = await call<PhaseGroupView>("create_phase_group", { name: t("phases.newGroupName") });
    if (!group) return;
    // Overlap is allowed by default; a new group has no phases, so this
    // cannot clash.
    const allowed = await call<PhaseSaveOutcome<PhaseGroupView>>("update_phase_group", { id: group.id, patch: { overlapAllowed: true } });
    if (allowed?.status === "saved") group = allowed.value;
    onGroupsChange((prev) => [...prev, group]);
    setFreshId(group.id);
    savedToast();
  }

  async function updateGroup(group: PhaseGroupView, patch: PhaseGroupPatch) {
    const outcome = await call<PhaseSaveOutcome<PhaseGroupView>>("update_phase_group", { id: group.id, patch });
    if (!outcome) return false;
    if (outcome.status === "overlap") {
      setConflict(group.id, outcome.pairs);
      return false;
    }
    setConflict(group.id, null);
    onGroupsChange((prev) => prev.map((g) => (g.id === group.id ? outcome.value : g)));
    savedToast();
    return true;
  }

  async function removeGroup(group: PhaseGroupView) {
    if (!(await run("remove_phase_group", { id: group.id }))) return;
    onGroupsChange((prev) => prev.filter((g) => g.id !== group.id));
    showToast(t("phases.toast.removed"));
  }

  async function moveGroup(id: string, toIndex: number) {
    const moved = await call<PhaseGroupView[]>("move_phase_group", { id, toIndex });
    if (!moved) return;
    onGroupsChange(moved);
    savedToast();
  }

  async function setGroupEye(group: PhaseGroupView) {
    const updated = await call<PhaseGroupView>("set_phase_group_visibility", { id: group.id, visible: group.visibility !== "visible" });
    if (updated) onGroupsChange((prev) => prev.map((g) => (g.id === group.id ? updated : g)));
  }

  async function setPhaseEye(phase: PhaseView) {
    const updated = await call<PhaseGroupView>("set_phase_visibility", { id: phase.id, visible: !phase.visible });
    if (updated) onGroupsChange((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
  }

  /// A new phase is only a draft row until both dates are entered: the
  /// fields start as 00.00.0000 instead of a guessed date that could clash
  /// with an existing phase before the user typed anything.
  function addPhase(group: PhaseGroupView) {
    setExpanded(group.id, true);
    setDraftGroups((prev) => new Set(prev).add(group.id));
  }

  function cancelDraft(groupId: string) {
    setDraftGroups((prev) => {
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
    setConflict(`new:${groupId}`, null);
  }

  async function createPhase(group: PhaseGroupView, title: string, startDate: string, endDate: string): Promise<boolean> {
    const input: PhaseInput = { title: title.trim() || t("phases.newPhaseTitle"), startDate, endDate, ongoing: false };
    const outcome = await call<PhaseSaveOutcome<PhaseView>>("create_phase", { groupId: group.id, input });
    if (!outcome) return false;
    if (outcome.status === "overlap") {
      setConflict(`new:${group.id}`, outcome.pairs);
      return false;
    }
    cancelDraft(group.id);
    setFreshId(outcome.value.id);
    await onReload();
    savedToast();
    return true;
  }

  async function updatePhase(phase: PhaseView, patch: PhasePatch): Promise<SaveResult> {
    const outcome = await call<PhaseSaveOutcome<PhaseView>>("update_phase", { id: phase.id, patch });
    if (!outcome) return "failed";
    if (outcome.status === "overlap") {
      setConflict(phase.id, outcome.pairs);
      return "overlap";
    }
    setConflict(phase.id, null);
    await onReload();
    savedToast();
    return "saved";
  }

  async function removePhase(phase: PhaseView) {
    if (!(await run("remove_phase", { id: phase.id }))) return;
    setConflict(phase.id, null);
    await onReload();
    showToast(t("phases.toast.removed"));
  }

  // ---- reordering the Themenbereiche (pointer events: WebKitGTK has no usable HTML5 drag & drop)

  function handleHandlePointerDown(ev: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setDrag({ id, overIndex: groups.findIndex((g) => g.id === id) });
  }

  function handleHandlePointerMove(ev: React.PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    const overIndex = dropIndex(groupElements.current, groups, drag.id, ev.clientY);
    if (overIndex !== drag.overIndex) setDrag({ id: drag.id, overIndex });
  }

  function handleHandlePointerUp() {
    if (!drag) return;
    const { id, overIndex } = drag;
    setDrag(null);
    if (overIndex !== groups.findIndex((g) => g.id === id)) void moveGroup(id, overIndex);
  }

  function handleHandleKeyDown(ev: React.KeyboardEvent<HTMLButtonElement>, index: number, id: string) {
    if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
    ev.preventDefault();
    const target = index + (ev.key === "ArrowUp" ? -1 : 1);
    if (target < 0 || target >= groups.length) return;
    const handle = ev.currentTarget;
    void moveGroup(id, target).then(() => {
      // The row is re-inserted at its new place; keep the keyboard on it so
      // Alt+Arrow can be repeated.
      requestAnimationFrame(() => {
        const current = document.querySelector<HTMLButtonElement>(`[data-phase-handle="${id}"]`);
        (current ?? handle).focus();
      });
    });
  }

  const others = drag ? groups.filter((g) => g.id !== drag.id) : [];
  const dropBeforeId = drag ? others[drag.overIndex]?.id : undefined;
  const dropAfterId = drag && drag.overIndex >= others.length ? others[others.length - 1]?.id : undefined;

  return (
    <div className="phases-modal" onMouseDown={(ev) => ev.target === ev.currentTarget && !drag && onClose()}>
      <div className="phases-modal__panel" role="dialog" aria-label={t("phases.title")}>
        <div className="phases-modal__header">
          <div className="phases-modal__title">{t("phases.title")}</div>
          <button className="icon-btn" onClick={onClose} title={t("phases.close")} aria-label={t("phases.close")}>
            ✕
          </button>
        </div>

        <div className="phases-modal__body">
          {groups.length === 0 ? (
            <div className="phases-empty">
              <p className="phases-empty__title">{t("phases.emptyTitle")}</p>
              <p className="phases-empty__hint">{t("phases.emptyHint")}</p>
              <button className="btn btn--primary" onClick={() => void createGroup()}>
                {t("phases.createGroup")}
              </button>
            </div>
          ) : (
            <>
              <p className="settings-group__intro">{t("phases.intro")}</p>
              <div className="phases-sort" role="group" aria-label={t("phases.sort")}>
                {(["recent", "manual"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={"phases-sort__btn" + (sortMode === mode ? " phases-sort__btn--active" : "")}
                    aria-pressed={sortMode === mode}
                    onClick={() => changeSortMode(mode)}
                  >
                    {t(mode === "recent" ? "phases.sortRecent" : "phases.sortManual")}
                  </button>
                ))}
              </div>
              {shownGroups.map((group, index) => (
                <section
                  key={group.id}
                  ref={(el) => {
                    if (el) groupElements.current.set(group.id, el);
                    else groupElements.current.delete(group.id);
                  }}
                  className={
                    "phases-group" +
                    (drag?.id === group.id ? " phases-group--dragging" : "") +
                    (dropBeforeId === group.id ? " phases-group--drop-before" : "") +
                    (dropAfterId === group.id ? " phases-group--drop-after" : "")
                  }
                >
                  <GroupHeader
                    group={group}
                    expanded={!collapsed.has(group.id)}
                    onToggle={() => setExpanded(group.id, collapsed.has(group.id))}
                    reorderable={sortMode === "manual"}
                    autoFocusName={freshId === group.id}
                    onRename={(name) => updateGroup(group, { name })}
                    onOverlap={(overlapAllowed) => void updateGroup(group, { overlapAllowed })}
                    onEye={() => void setGroupEye(group)}
                    onRemove={() => void removeGroup(group)}
                    onHandlePointerDown={(ev) => handleHandlePointerDown(ev, group.id)}
                    onHandlePointerMove={handleHandlePointerMove}
                    onHandlePointerUp={handleHandlePointerUp}
                    onHandleKeyDown={(ev) => handleHandleKeyDown(ev, index, group.id)}
                  />
                  {conflicts[group.id] && <ConflictMessage pairs={conflicts[group.id]} />}

                  {!collapsed.has(group.id) && (
                  <div className="settings-group__box">
                    {group.phases.length === 0 && !draftGroups.has(group.id) && (
                      <div className="phases-row phases-row--empty">{t("phases.noPhases")}</div>
                    )}
                    {group.phases.map((phase) => (
                      <PhaseRow
                        key={phase.id}
                        phase={phase}
                        palette={palette}
                        autoFocusTitle={freshId === phase.id}
                        conflict={conflicts[phase.id]}
                        onSave={(patch) => updatePhase(phase, patch)}
                        onEye={() => void setPhaseEye(phase)}
                        onRemove={() => void removePhase(phase)}
                      />
                    ))}
                    {draftGroups.has(group.id) && (
                      <NewPhaseRow
                        conflict={conflicts[`new:${group.id}`]}
                        onCreate={(title, start, end) => createPhase(group, title, start, end)}
                        onCancel={() => cancelDraft(group.id)}
                      />
                    )}
                    <button className="phases-add" onClick={() => addPhase(group)} disabled={draftGroups.has(group.id)}>
                      + {t("phases.addPhase")}
                    </button>
                  </div>
                  )}
                </section>
              ))}
              <button className="btn" onClick={() => void createGroup()}>
                + {t("phases.createGroup")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface GroupHeaderProps {
  group: PhaseGroupView;
  expanded: boolean;
  onToggle: () => void;
  reorderable: boolean;
  autoFocusName: boolean;
  onRename: (name: string) => Promise<boolean>;
  onOverlap: (overlapAllowed: boolean) => void;
  onEye: () => void;
  onRemove: () => void;
  onHandlePointerDown: (ev: React.PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerMove: (ev: React.PointerEvent<HTMLButtonElement>) => void;
  onHandlePointerUp: () => void;
  onHandleKeyDown: (ev: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function GroupHeader({
  group,
  expanded,
  onToggle,
  reorderable,
  autoFocusName,
  onRename,
  onOverlap,
  onEye,
  onRemove,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandleKeyDown,
}: GroupHeaderProps) {
  const [name, setName] = useState(group.name);
  useEffect(() => setName(group.name), [group.name]);

  async function commitName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) {
      setName(group.name);
      return;
    }
    if (!(await onRename(trimmed))) setName(group.name);
  }

  return (
    <div className="phases-group__header">
      <button
        className="phases-iconbtn"
        onClick={onToggle}
        title={t(expanded ? "phases.collapse" : "phases.expand")}
        aria-label={t(expanded ? "phases.collapse" : "phases.expand")}
        aria-expanded={expanded}
      >
        <ChevronIcon expanded={expanded} />
      </button>
      {reorderable && (
      <button
        className="phases-iconbtn phases-iconbtn--handle"
        data-phase-handle={group.id}
        title={t("phases.dragGroup")}
        aria-label={t("phases.dragGroup")}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onKeyDown={onHandleKeyDown}
      >
        <DragHandleIcon />
      </button>
      )}
      <button
        className="phases-iconbtn"
        onClick={onEye}
        title={t(group.visibility === "visible" ? "phases.hideAll" : "phases.showAll")}
        aria-label={t(group.visibility === "visible" ? "phases.hideAll" : "phases.showAll")}
      >
        <VisibilityEye state={group.visibility} />
      </button>
      <input
        className="phases-input phases-group__name"
        value={name}
        autoFocus={autoFocusName}
        aria-label={t("phases.groupName")}
        onFocus={(ev) => ev.target.select()}
        onChange={(ev) => setName(ev.target.value)}
        onBlur={() => void commitName()}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.currentTarget.blur();
          if (ev.key === "Escape") {
            ev.stopPropagation();
            setName(group.name);
            ev.currentTarget.blur();
          }
        }}
      />
      {!expanded && (
        <span className="phases-group__count">{t("phases.phaseCount").replace("{n}", String(group.phases.length))}</span>
      )}
      <ToggleSwitch checked={group.overlapAllowed} onChange={onOverlap} label={t("phases.overlapAllowed")} />
      <button className="phases-iconbtn" onClick={onRemove} title={t("phases.removeGroup")} aria-label={t("phases.removeGroup")}>
        <TrashIcon />
      </button>
    </div>
  );
}

interface NewPhaseRowProps {
  conflict: PhaseOverlapPair[] | undefined;
  onCreate: (title: string, startDate: string, endDate: string) => Promise<boolean>;
  onCancel: () => void;
}

function NewPhaseRow({ conflict, onCreate, onCancel }: NewPhaseRowProps) {
  const [title, setTitle] = useState(t("phases.newPhaseTitle"));
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Saved as soon as both dates are in; an empty one ("") keeps waiting.
  function tryCreate(start: string, end: string) {
    if (start && end) void onCreate(title, start, end);
  }

  return (
    <div className="phases-row">
      <div className="phases-row__main">
        <input
          className="phases-input phases-row__title"
          value={title}
          autoFocus
          aria-label={t("phases.phaseTitle")}
          onFocus={(ev) => ev.target.select()}
          onChange={(ev) => setTitle(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Escape") {
              ev.stopPropagation();
              onCancel();
            }
          }}
        />
        <button className="phases-iconbtn" onClick={onCancel} title={t("phases.removePhase")} aria-label={t("phases.removePhase")}>
          <TrashIcon />
        </button>
      </div>
      <div className="phases-row__dates">
        <SegmentedDateTimeInput
          className="phases-date"
          dateOnly
          autoFocus={false}
          value={startDate}
          onChange={setStartDate}
          onCommit={(value) => tryCreate(value, endDate)}
        />
        <span className="phases-row__dash">–</span>
        <SegmentedDateTimeInput
          className="phases-date"
          dateOnly
          autoFocus={false}
          value={endDate}
          onChange={setEndDate}
          onCommit={(value) => tryCreate(startDate, value)}
        />
      </div>
      {/* The fields start empty (00.00.0000) on purpose, see addPhase. */}
      <div className="phases-row__draft-hint">{t("phases.draftHint")}</div>
      {conflict && <ConflictMessage pairs={conflict} />}
    </div>
  );
}

interface PhaseRowProps {
  phase: PhaseView;
  palette: string[];
  autoFocusTitle: boolean;
  conflict: PhaseOverlapPair[] | undefined;
  onSave: (patch: PhasePatch) => Promise<SaveResult>;
  onEye: () => void;
  onRemove: () => void;
}

function PhaseRow({ phase, palette, autoFocusTitle, conflict, onSave, onEye, onRemove }: PhaseRowProps) {
  const [title, setTitle] = useState(phase.title);
  const [startDate, setStartDate] = useState(phase.startDate);
  const [endDate, setEndDate] = useState(phase.endDate);
  const [colorOpen, setColorOpen] = useState(false);

  // The stored values win again after every save and reload — and after a
  // refusal, whose draft is put back by `save` below.
  useEffect(() => {
    setTitle(phase.title);
    setStartDate(phase.startDate);
    setEndDate(phase.endDate);
  }, [phase.title, phase.startDate, phase.endDate]);

  /// Sends only what differs from the stored phase. A clash keeps the draft
  /// on screen next to the message; any other refusal puts the stored
  /// values back.
  async function save(draft: PhasePatch) {
    const patch: PhasePatch = {};
    if (draft.title !== undefined && draft.title.trim() !== phase.title) patch.title = draft.title.trim();
    if (draft.startDate !== undefined && draft.startDate !== phase.startDate) patch.startDate = draft.startDate;
    if (draft.endDate !== undefined && draft.endDate !== phase.endDate) patch.endDate = draft.endDate;
    if (draft.color !== undefined && draft.color !== phase.color) patch.color = draft.color;
    if (draft.ongoing !== undefined && draft.ongoing !== phase.ongoing) patch.ongoing = draft.ongoing;
    if (Object.keys(patch).length === 0) {
      setTitle(phase.title);
      return;
    }
    if ((await onSave(patch)) === "failed") {
      setTitle(phase.title);
      setStartDate(phase.startDate);
      setEndDate(phase.endDate);
    }
  }

  return (
    <div className="phases-row">
      <div className="phases-row__main">
        <button
          className="phases-iconbtn"
          onClick={onEye}
          title={t(phase.visible ? "phases.hidePhase" : "phases.showPhase")}
          aria-label={t(phase.visible ? "phases.hidePhase" : "phases.showPhase")}
        >
          <VisibilityEye state={phase.visible ? "visible" : "hidden"} />
        </button>
        <div className="phases-color">
          <button
            className="phases-swatch"
            style={{ backgroundColor: phase.color }}
            onClick={() => setColorOpen((v) => !v)}
            title={t("phases.color")}
            aria-label={t("phases.color")}
            aria-expanded={colorOpen}
          />
          {colorOpen && (
            <PhaseColorPopup
              palette={palette}
              value={phase.color}
              onPick={(color) => {
                setColorOpen(false);
                void save({ color });
              }}
              onClose={() => setColorOpen(false)}
            />
          )}
        </div>
        <input
          className="phases-input phases-row__title"
          value={title}
          autoFocus={autoFocusTitle}
          aria-label={t("phases.phaseTitle")}
          onFocus={(ev) => ev.target.select()}
          onChange={(ev) => setTitle(ev.target.value)}
          onBlur={() => void save({ title })}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") ev.currentTarget.blur();
            if (ev.key === "Escape") {
              ev.stopPropagation();
              setTitle(phase.title);
              ev.currentTarget.blur();
            }
          }}
        />
        <button className="phases-iconbtn" onClick={onRemove} title={t("phases.removePhase")} aria-label={t("phases.removePhase")}>
          <TrashIcon />
        </button>
      </div>

      <div className="phases-row__dates">
        <SegmentedDateTimeInput
          className="phases-date"
          dateOnly
          autoFocus={false}
          value={startDate}
          onChange={setStartDate}
          onCommit={(value) => void save({ startDate: value })}
        />
        <span className="phases-row__dash">–</span>
        {phase.ongoing ? (
          <span className="phases-date phases-date--static" title={t("phases.ongoingEnd")}>
            {formatDay(phase.endDate)}
          </span>
        ) : (
          <SegmentedDateTimeInput
            className="phases-date"
            dateOnly
            autoFocus={false}
            value={endDate}
            onChange={setEndDate}
            onCommit={(value) => void save({ endDate: value })}
          />
        )}
        <label className="phases-row__ongoing">
          <input type="checkbox" checked={phase.ongoing} onChange={(ev) => void save({ ongoing: ev.target.checked })} />
          {t("phases.ongoing")}
        </label>
      </div>

      {conflict && <ConflictMessage pairs={conflict} />}
    </div>
  );
}
