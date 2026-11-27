import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../busy";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { LANGUAGES, LANGUAGE_NATIVE_NAMES, currentLanguage, quoted, setLanguage, t } from "../i18n";
import { setTheme, useTheme } from "../theme";
import type { OpenPrecheckResult, OpenProjectResult, ProjectInfo, RecentProjectEntry } from "../types";
import CopyProgress from "./CopyProgress";
import DeleteStreamDialog, { formatBytes } from "./DeleteStreamDialog";
import DeletedStreamsDialog from "./DeletedStreamsDialog";
import { useToast } from "../ToastContext";
import { useConfirm } from "../ConfirmContext";
import { useWindowKeydown } from "../hooks/useWindowKeydown";
import SupportLink from "./SupportLink";
import SegmentedControl from "./filebrowser/settings/SegmentedControl";

/** The tile search only appears once the list is long enough to need it. */
const SEARCH_MIN_PROJECTS = 10;

interface StartScreenProps {
  onProjectOpened: (project: ProjectInfo) => void;
  /// Called with a display label as soon as it's clear the open attempt
  /// will proceed (no lock conflict to resolve first), and with `null` once
  /// it's settled either way — lets the app shell show a loading view
  /// immediately instead of only after `open_project` has fully returned.
  onOpeningChange: (label: string | null) => void;
}

type PendingPrompt =
  | { kind: "missing"; path: string }
  | { kind: "lock_stale"; path: string; pid: number }
  | { kind: "lock_active"; path: string; pid: number };

type DuplicateStep = "destination";

interface ActiveCopyTask {
  // `null` until `start_duplicate_project` resolves — see CopyProgress for
  // why the overlay is shown before the task id is known.
  taskId: string | null;
  title: string;
}

/// Best-effort display name for a project path that isn't necessarily in
/// the recent list yet (e.g. just picked via the folder dialog) — mirrors
/// the backend's own fallback in `project::project_name_from_path`.
function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

// Set once the "open the default stream" attempt has run. Module-level on
// purpose: the start screen is mounted again by the back button and by a
// language switch, and neither may open the default a second time — only a
// real app start does.
let defaultAutoOpenDone = false;

export default function StartScreen({ onProjectOpened, onOpeningChange }: StartScreenProps) {
  const [recent, setRecent] = useState<RecentProjectEntry[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const showToast = useToast();
  const confirm = useConfirm();
  // The wordmark is white on the dark logo; the light one carries it in ink.
  const theme = useTheme();
  const logoSrc = theme === "light" ? "/logo_light.png" : "/logo.png";
  // The stream whose deletion is being confirmed, and whether the list
  // of already-deleted ones is open.
  const [deleting, setDeleting] = useState<RecentProjectEntry | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [showRestoreMenu, setShowRestoreMenu] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Where the open tile menu hangs from: the "⋯" button's box. The menu is
  // portalled to <body> with fixed coordinates, because inside the
  // scrolling stream list (`overflow-y: auto`) it was clipped and its lower
  // entries ("Endgültig löschen…") were only reachable by scrolling the list.
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const tileMenuRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [duplicateStep, setDuplicateStep] = useState<DuplicateStep | null>(null);
  const [duplicateSourcePath, setDuplicateSourcePath] = useState<string | null>(null);
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [activeCopyTask, setActiveCopyTask] = useState<ActiveCopyTask | null>(null);

  const [renameTarget, setRenameTarget] = useState<RecentProjectEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    refreshRecent(true);
  }, []);

  // The "Wiederherstellen & Papierkorb" menu closes on Escape like the
  // other dialogs.
  useWindowKeydown((ev) => {
    if (ev.key === "Escape" && showRestoreMenu) setShowRestoreMenu(false);
  });

  // Right-aligned below its "⋯" button; flipped above it when the window has
  // no room below, and kept inside the window either way.
  function placeTileMenu() {
    const menu = tileMenuRef.current;
    const anchor = menuAnchorRef.current;
    if (!menu || !anchor) return;
    const margin = 8;
    const box = anchor.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    let top = box.bottom + 4;
    if (top + height > window.innerHeight - margin && box.top - 4 - height >= margin) {
      top = box.top - 4 - height;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    const left = Math.max(margin, Math.min(box.right - width, window.innerWidth - width - margin));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  useLayoutEffect(() => {
    if (menuFor !== null) placeTileMenu();
  }, [menuFor]);

  // The tile menu closes on any click elsewhere or on Escape. Scrolling and
  // resizing move it along with its button rather than closing it: a scroll
  // event arriving right after the opening click (scrolling the button into
  // view does that) shut the menu again before it could be used.
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    const follow = () => placeTileMenu();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [menuFor]);

  async function refreshRecent(autoOpenDefault = false) {
    try {
      const list = await invoke<RecentProjectEntry[]>("list_recent_projects");
      setRecent(list);
      if (autoOpenDefault && !defaultAutoOpenDone) {
        defaultAutoOpenDone = true;
        const standard = list.find((entry) => entry.is_default);
        if (standard) void openDefaultOnStart(standard);
      }
      // Counts fill in after the tiles are already shown.
      invoke<Record<string, number>>("count_project_items", { paths: list.map((e) => e.path) })
        .then(setItemCounts)
        .catch(() => setItemCounts({}));
    } catch {
      setRecent([]);
    }
  }

  function openCreateModal() {
    setProjectName("");
    setCreateError(null);
    setShowCreateModal(true);
  }

  async function handleChooseLocation() {
    const trimmedName = projectName.trim();
    if (!trimmedName) return;

    const parent = await openDialog({ directory: true, multiple: false, title: t("start.chooseLocation") });
    if (!parent || Array.isArray(parent)) return;

    setBusy(true);
    setCreateError(null);
    try {
      const project = await invoke<ProjectInfo>("create_project", { name: trimmedName, parentPath: parent });
      setShowCreateModal(false);
      onProjectOpened(project);
    } catch (e) {
      setCreateError(typeof e === "string" ? e : t("start.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  /// The last step of opening an existing stream: when its folder was
  /// moved, copied by hand or sits on a drive mounted under another path, its
  /// database still points at the old place (see `relocation.rs`). Offers to
  /// adjust that before the timeline loads; declining opens it as before.
  async function finishOpen(project: ProjectInfo) {
    try {
      const moved = await invoke<{ oldRoot: string; total: number; checked: number; present: number } | null>(
        "check_project_relocation",
      );
      if (
        moved &&
        (await confirm({
          title: t("start.relocatedTitle"),
          body: t("start.relocatedBody")
            .replace("{old}", moved.oldRoot)
            .replace("{present}", String(moved.present))
            .replace("{checked}", String(moved.checked)),
          confirmLabel: t("start.relocatedConfirm"),
          countdownSeconds: 0,
        }))
      ) {
        try {
          await invoke<number>("relocate_project_paths", { oldRoot: moved.oldRoot });
          showToast(t("start.relocatedDone"));
        } catch (e) {
          showToast(`${t("start.relocateFailed")} ${String(e)}`);
        }
      }
    } catch (e) {
      // The check itself failing must not keep the stream from opening.
      invoke("debug_log", { message: `check_project_relocation failed: ${String(e)}` }).catch(() => {});
    }
    onProjectOpened(project);
  }

  async function handleOpenResult(result: OpenProjectResult, path: string) {
    switch (result.status) {
      case "opened":
        await finishOpen(result.project);
        return;
      case "not_a_project":
        setPrompt({ kind: "missing", path });
        return;
      case "lock_stale":
        setPrompt({ kind: "lock_stale", path, pid: result.pid });
        return;
      case "lock_active":
        setPrompt({ kind: "lock_active", path, pid: result.pid });
        return;
    }
  }

  async function handleOpenRecent(path: string) {
    setError(null);
    setBusy(true);
    try {
      // Cheap folder/lock check first — lets a conflict still show its
      // prompt right here, without ever flashing the "opening" view, while
      // a clear path switches the app shell over immediately instead of
      // only once the (potentially slow) `open_project` below has
      // returned.
      const precheck = await invoke<OpenPrecheckResult>("precheck_open_project", { path });
      if (precheck.status !== "ready") {
        await handleOpenResult(precheck, path);
        return;
      }
      const label = recent.find((entry) => entry.path === path)?.name ?? basenameOf(path);
      onOpeningChange(label);
      const result = await invoke<OpenProjectResult>("open_project", { path, force: false });
      await handleOpenResult(result, path);
    } catch (e) {
      setError(typeof e === "string" ? e : t("start.errorGeneric"));
    } finally {
      setBusy(false);
      onOpeningChange(null);
    }
  }

  /// App-start variant of `handleOpenRecent`: when the default stream
  /// can't be opened right away (folder gone, drive not mounted, locked by
  /// another instance), the normal start screen stays with a short note
  /// instead of the lock/missing prompts.
  async function openDefaultOnStart(entry: RecentProjectEntry) {
    setBusy(true);
    try {
      const precheck = await invoke<OpenPrecheckResult>("precheck_open_project", { path: entry.path });
      // A stale lock is left behind by an app run that ended without
      // releasing it — its owner is gone, so taking over is safe. Only a
      // lock held by a live process keeps the default from opening.
      if (precheck.status !== "ready" && precheck.status !== "lock_stale") {
        setError(`${t("start.defaultOpenFailed")} ${quoted(entry.name)}`);
        return;
      }
      onOpeningChange(entry.name);
      const result = await invoke<OpenProjectResult>("open_project", {
        path: entry.path,
        force: precheck.status === "lock_stale",
      });
      if (result.status === "opened") {
        await finishOpen(result.project);
      } else {
        setError(`${t("start.defaultOpenFailed")} ${quoted(entry.name)}`);
      }
    } catch {
      setError(`${t("start.defaultOpenFailed")} ${quoted(entry.name)}`);
    } finally {
      setBusy(false);
      onOpeningChange(null);
    }
  }

  async function handleToggleDefault(entry: RecentProjectEntry, ev: React.MouseEvent) {
    ev.stopPropagation();
    try {
      await invoke("set_default_project", { path: entry.path, enabled: !entry.is_default });
      await refreshRecent();
    } catch {
      // ignore — the switch simply stays as it was
    }
  }

  async function handleOpenFolder() {
    const picked = await openDialog({ directory: true, multiple: false, title: t("start.openFolderButton") });
    if (!picked || Array.isArray(picked)) return;
    await handleOpenRecent(picked);
  }

  async function handleRemoveRecent(path: string, ev: React.MouseEvent) {
    ev.stopPropagation();
    try {
      await invoke("remove_recent_project", { path });
      await refreshRecent();
    } catch {
      // ignore — worst case it stays in the list
    }
  }

  async function confirmForceOpen(path: string) {
    setPrompt(null);
    setBusy(true);
    const label = recent.find((entry) => entry.path === path)?.name ?? basenameOf(path);
    onOpeningChange(label);
    try {
      const result = await invoke<OpenProjectResult>("open_project", { path, force: true });
      await handleOpenResult(result, path);
    } catch (e) {
      setError(typeof e === "string" ? e : t("start.errorGeneric"));
    } finally {
      setBusy(false);
      onOpeningChange(null);
    }
  }

  async function confirmRemoveMissing(path: string) {
    setPrompt(null);
    try {
      await invoke("remove_recent_project", { path });
      await refreshRecent();
    } catch {
      // ignore
    }
  }

  /// Restoring is a full copy of a backup folder to a new place, so it runs on
  /// the duplicate command; only the wording and the entry point differ.
  async function openRestoreFlow() {
    setShowRestoreMenu(false);
    const picked = await openDialog({ directory: true, multiple: false, title: t("start.restoreSourceTitle") });
    if (!picked || Array.isArray(picked)) return;
    const folder = picked.split(/[\\/]/).filter(Boolean).pop() ?? t("start.namePlaceholder");
    // Backups are named "<name>-Backup-<date>_<time>"; suggest the plain name.
    const guessedName = folder.replace(/-Backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/, "") || folder;
    setDuplicateSourcePath(picked);
    setDuplicateName(guessedName);
    setDuplicateError(null);
    setDuplicateStep("destination");
  }

  function closeDuplicateFlow() {
    setDuplicateStep(null);
  }

  async function handleDuplicateChooseLocation() {
    const trimmedName = duplicateName.trim();
    if (!trimmedName || !duplicateSourcePath) return;

    const parent = await openDialog({ directory: true, multiple: false, title: t("start.chooseLocation") });
    if (!parent || Array.isArray(parent)) return;

    setDuplicateBusy(true);
    setDuplicateError(null);
    setDuplicateStep(null);
    // Show the overlay (taskId still null) before the command resolves —
    // the backend's copy thread can start emitting progress, and can fail,
    // within milliseconds, faster than `invoke` returns a task id.
    // CopyProgress attaches its event listener on mount regardless of
    // taskId, so nothing emitted in that window is lost.
    setActiveCopyTask({ taskId: null, title: t("start.restoreProgressTitle") });
    try {
      const taskId = await invoke<string>("start_duplicate_project", {
        sourcePath: duplicateSourcePath,
        destinationParent: parent,
        newName: trimmedName,
      });
      setActiveCopyTask({ taskId, title: t("start.restoreProgressTitle") });
    } catch (e) {
      setActiveCopyTask(null);
      setDuplicateStep("destination");
      setDuplicateError(typeof e === "string" ? e : t("start.errorGeneric"));
    } finally {
      setDuplicateBusy(false);
    }
  }

  function handleCopyDone(resultPath: string | null) {
    setActiveCopyTask(null);
    showToast(t("start.restoreSuccessToast"));
    refreshRecent();
    if (resultPath) void handleOpenRecent(resultPath);
  }

  function handleCopyCancelled() {
    setActiveCopyTask(null);
    showToast(t("start.restoreCancelledToast"));
  }

  function handleCopyError(message: string) {
    setActiveCopyTask(null);
    showToast(message || t("start.restoreErrorToast"));
  }

  function openRename(entry: RecentProjectEntry, ev: React.MouseEvent) {
    ev.stopPropagation();
    setRenameTarget(entry);
    setRenameValue(entry.name);
    setRenameError(null);
  }

  function closeRename() {
    setRenameTarget(null);
  }

  async function confirmRename() {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;

    setRenameBusy(true);
    setRenameError(null);
    try {
      await invoke("rename_project", { path: renameTarget.path, newName: trimmed });
      setRenameTarget(null);
      await refreshRecent();
    } catch (e) {
      setRenameError(typeof e === "string" ? e : t("start.renameErrorToast"));
    } finally {
      setRenameBusy(false);
    }
  }

  return (
    <div className="start-screen">
      {/* Also here, not only in a stream's settings: before the first stream
          exists there is no other place to change them. */}
      <div className="start-screen__corner">
        <SegmentedControl
          label={t("settings.language")}
          value={currentLanguage()}
          onPick={setLanguage}
          options={LANGUAGES.map((language) => ({
            value: language,
            label: LANGUAGE_NATIVE_NAMES[language],
            lang: language,
          }))}
        />
        <SegmentedControl
          label={t("settings.theme")}
          value={theme}
          onPick={setTheme}
          options={[
            { value: "light", label: t("settings.themeLight") },
            { value: "dark", label: t("settings.themeDark") },
          ]}
        />
        <SupportLink />
      </div>
      <div className="start-screen__header">
        <img className="start-screen__logo" src={logoSrc} alt={t("start.title")} />
      </div>

      {error && <div className="start-screen__error">{error}</div>}

      {recent.length === 0 ? (
        <div className="start-screen__welcome">
          <h2 className="start-screen__welcome-title">{t("start.welcomeTitle")}</h2>
          <p className="start-screen__welcome-text">{t("start.welcomeText")}</p>
          <button className="btn btn--primary" onClick={openCreateModal} disabled={busy}>
            {t("start.createFirstButton")}
          </button>
          <div className="start-screen__toolbar start-screen__toolbar--welcome">
            <button className="btn" onClick={handleOpenFolder} disabled={busy}>
              {t("start.openFolderButton")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="start-screen__toolbar">
            <button className="btn btn--primary" onClick={openCreateModal} disabled={busy}>
              + {t("start.createButton")}
            </button>
            <button className="btn" onClick={handleOpenFolder} disabled={busy}>
              {t("start.openFolderButton")}
            </button>
          </div>

          <div className="start-screen__recent">
            <div className="start-screen__recent-head">
              <h2 className="start-screen__recent-heading">{t("start.recentHeading")}</h2>
              {recent.length > SEARCH_MIN_PROJECTS && (
                <input
                  type="search"
                  className="text-input start-screen__search"
                  placeholder={t("start.searchPlaceholder")}
                  aria-label={t("start.searchPlaceholder")}
                  value={search}
                  onChange={(ev) => setSearch(ev.target.value)}
                />
              )}
            </div>
            <div className="tile-grid">
              {recent
                .filter(
                  (entry) =>
                    recent.length <= SEARCH_MIN_PROJECTS ||
                    entry.name.toLowerCase().includes(search.trim().toLowerCase()),
                )
                .map((entry) => (
                  <div
                    key={entry.path}
                    className="project-tile project-tile--start"
                    title={entry.path}
                    onClick={() => handleOpenRecent(entry.path)}
                  >
                    {entry.is_default && (
                      <span className="project-tile__badge" title={t("start.defaultHint")}>
                        ★ {t("start.defaultLabel")}
                      </span>
                    )}
                    <button
                      className="btn--text project-tile__menu-btn"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        menuAnchorRef.current = ev.currentTarget;
                        setMenuFor(menuFor === entry.path ? null : entry.path);
                      }}
                      title={t("start.menuMore")}
                      aria-label={t("start.menuMore")}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === entry.path}
                    >
                      ⋯
                    </button>
                    {menuFor === entry.path && createPortal(
                      <div
                        ref={tileMenuRef}
                        className="tile-menu tile-menu--floating"
                        role="menu"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <button role="menuitem" onClick={() => { setMenuFor(null); void handleOpenRecent(entry.path); }}>
                          {t("start.menuOpen")}
                        </button>
                        <button role="menuitem" onClick={(ev) => { setMenuFor(null); openRename(entry, ev); }}>
                          {t("start.rename")}…
                        </button>
                        <button role="menuitem" onClick={(ev) => { setMenuFor(null); void handleToggleDefault(entry, ev); }}>
                          {entry.is_default ? t("start.menuUnsetDefault") : t("start.menuSetDefault")}
                        </button>
                        <hr />
                        <button role="menuitem" onClick={(ev) => { setMenuFor(null); void handleRemoveRecent(entry.path, ev); }}>
                          {t("start.remove")}
                        </button>
                        <button
                          role="menuitem"
                          className="tile-menu__danger"
                          onClick={() => { setMenuFor(null); setDeleting(entry); }}
                        >
                          {t("start.menuDelete")}
                        </button>
                      </div>,
                      document.body,
                    )}
                    <div className="project-tile__icon">🎞️</div>
                    <div className="project-tile__name">{entry.name}</div>
                    {itemCounts[entry.path] !== undefined && (
                      <div className="project-tile__meta" title={t("start.fileCount")}>
                        {itemCounts[entry.path]}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </>
      )}

      <button className="start-screen__restore-link" onClick={() => setShowRestoreMenu(true)} disabled={busy}>
        {t("start.restoreLink")}
      </button>

      {showRestoreMenu && (
        <div className="modal-overlay" onClick={() => setShowRestoreMenu(false)}>
          <div className="modal-card" onClick={(ev) => ev.stopPropagation()}>
            <h3 className="modal-card__title">{t("start.restoreMenuTitle")}</h3>
            <div className="restore-menu">
              <button
                className="btn"
                onClick={() => {
                  setShowRestoreMenu(false);
                  setShowDeleted(true);
                }}
              >
                {t("start.deletedButton")}
              </button>
              <button className="btn" onClick={openRestoreFlow}>
                {t("start.restoreFromBackup")}
              </button>
            </div>
            <div className="modal-card__actions">
              <button className="btn" onClick={() => setShowRestoreMenu(false)}>
                {t("start.restoreMenuClose")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3 className="modal-card__title">{t("start.createModalTitle")}</h3>
            <p className="modal-card__body">{t("start.createModalExplain")}</p>
            <input
              className="text-input"
              value={projectName}
              onChange={(ev) => setProjectName(ev.target.value)}
              placeholder={t("start.namePlaceholder")}
              autoFocus
              onKeyDown={(ev) => {
                if (ev.key === "Enter") handleChooseLocation();
              }}
            />
            {createError && <p className="modal-card__error">{createError}</p>}
            <div className="modal-card__actions">
              <button className="btn" onClick={() => setShowCreateModal(false)} disabled={busy}>
                {t("start.cancel")}
              </button>
              <button
                className="btn btn--primary"
                onClick={handleChooseLocation}
                disabled={busy || !projectName.trim()}
              >
                {t("start.chooseLocation")}
              </button>
            </div>
          </div>
        </div>
      )}

      {duplicateStep === "destination" && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3 className="modal-card__title">{t("start.restoreDestTitle")}</h3>
            <p className="modal-card__body">{t("start.restoreDestExplain")}</p>
            <input
              className="text-input"
              value={duplicateName}
              onChange={(ev) => setDuplicateName(ev.target.value)}
              placeholder={t("start.namePlaceholder")}
              autoFocus
              onKeyDown={(ev) => {
                if (ev.key === "Enter") handleDuplicateChooseLocation();
              }}
            />
            {duplicateError && <p className="modal-card__error">{duplicateError}</p>}
            <div className="modal-card__actions">
              <button className="btn" onClick={closeDuplicateFlow} disabled={duplicateBusy}>
                {t("start.cancel")}
              </button>
              <button
                className="btn btn--primary"
                onClick={handleDuplicateChooseLocation}
                disabled={duplicateBusy || !duplicateName.trim()}
              >
                {t("start.chooseLocation")}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeCopyTask && (
        <CopyProgress
          taskId={activeCopyTask.taskId}
          title={activeCopyTask.title}
          onDone={handleCopyDone}
          onCancelled={handleCopyCancelled}
          onError={handleCopyError}
        />
      )}

      {renameTarget && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3 className="modal-card__title">{t("start.renameTitle")}</h3>
            <input
              className="text-input"
              value={renameValue}
              onChange={(ev) => setRenameValue(ev.target.value)}
              autoFocus
              onKeyDown={(ev) => {
                if (ev.key === "Enter") confirmRename();
              }}
            />
            {renameError && <p className="modal-card__error">{renameError}</p>}
            <div className="modal-card__actions">
              <button className="btn" onClick={closeRename} disabled={renameBusy}>
                {t("start.cancel")}
              </button>
              <button
                className="btn btn--primary"
                onClick={confirmRename}
                disabled={renameBusy || !renameValue.trim()}
              >
                {t("start.renameConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {prompt && (
        <div className="modal-overlay">
          <div className="modal-card">
            {prompt.kind === "missing" && (
              <>
                <h3 className="modal-card__title">{t("start.missingTitle")}</h3>
                <p className="modal-card__body">{t("start.missingBody")}</p>
                <div className="modal-card__actions">
                  <button className="btn" onClick={() => setPrompt(null)}>
                    {t("start.missingCancel")}
                  </button>
                  <button className="btn btn--primary" onClick={() => confirmRemoveMissing(prompt.path)}>
                    {t("start.missingRemove")}
                  </button>
                </div>
              </>
            )}
            {prompt.kind === "lock_stale" && (
              <>
                <h3 className="modal-card__title">{t("start.lockStaleTitle")}</h3>
                <p className="modal-card__body">{t("start.lockStaleBody")}</p>
                <div className="modal-card__actions">
                  <button className="btn" onClick={() => setPrompt(null)}>
                    {t("start.lockStaleCancel")}
                  </button>
                  <button className="btn btn--primary" onClick={() => confirmForceOpen(prompt.path)}>
                    {t("start.lockStaleConfirm")}
                  </button>
                </div>
              </>
            )}
            {prompt.kind === "lock_active" && (
              <>
                <h3 className="modal-card__title">{t("start.lockActiveTitle")}</h3>
                <p className="modal-card__body">{t("start.lockActiveBody")}</p>
                <p className="modal-card__hint">{t("start.lockActiveForceHint")}</p>
                <div className="modal-card__actions">
                  <button className="btn" onClick={() => setPrompt(null)}>
                    {t("start.lockActiveOk")}
                  </button>
                  <button className="btn btn--danger" onClick={() => confirmForceOpen(prompt.path)}>
                    {t("start.lockActiveForce")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleting && (
        <DeleteStreamDialog
          path={deleting.path}
          onCancel={() => setDeleting(null)}
          onDeleted={(outcome) => {
            setDeleting(null);
            showToast(
              `${t("start.deletedToast")} ${quoted(outcome.name)} – ${formatBytes(outcome.freedBytes)} ${t("start.freedSuffix")}`,
            );
            void refreshRecent();
          }}
        />
      )}

      {showDeleted && (
        <DeletedStreamsDialog
          onClose={() => setShowDeleted(false)}
          onRestored={(report) => {
            showToast(`${t("start.restoredToast")} ${quoted(report.name)}`);
            void refreshRecent();
          }}
        />
      )}
    </div>
  );
}
