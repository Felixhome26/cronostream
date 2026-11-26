import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import StartScreen from "./components/StartScreen";
import ProjectShell from "./components/ProjectShell";
import type { ProjectInfo } from "./types";
import { useFullscreen } from "./useFullscreen";
import { t, useLanguage } from "./i18n";
import { ToastProvider } from "./ToastContext";
import { ProgressProvider } from "./ProgressContext";
import { ConfirmProvider } from "./ConfirmContext";
import { BusyIndicator } from "./busy";
import TextContextMenu from "./components/TextContextMenu";
import UpdateNotifier from "./components/UpdateNotifier";
import WelcomeDialog from "./components/WelcomeDialog";
import { isWelcomeHidden } from "./utils/welcome";
import UninstallDialog, { OPEN_UNINSTALL_EVENT } from "./components/UninstallDialog";

function App() {
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  // Set the moment a project-open attempt commits (no lock conflict to show
  // a prompt for first) and cleared once it settles either way — lets the
  // start screen be covered by a loading view immediately, instead of the
  // whole app sitting idle until `open_project` (which can take a while on
  // a large project) returns. See StartScreen's `onOpeningChange`.
  const [openingLabel, setOpeningLabel] = useState<string | null>(null);
  const { isFullscreen, toggleFullscreen } = useFullscreen();
  const [showWelcome, setShowWelcome] = useState(() => !isWelcomeHidden());
  const [showUninstall, setShowUninstall] = useState(false);

  // The settings row opens the uninstall dialog through a window event, the
  // start menu entry "CronoStream deinstallieren" through the backend: as a
  // request waiting for this window, or as an event once it is up.
  useEffect(() => {
    const open = () => {
      setShowWelcome(false);
      setShowUninstall(true);
    };
    const takeRequest = () => {
      invoke<boolean>("take_uninstall_request")
        .then((requested) => {
          if (requested) open();
        })
        .catch(() => {});
    };
    window.addEventListener(OPEN_UNINSTALL_EVENT, open);
    const unlisten = listen("uninstall-requested", takeRequest);
    takeRequest();
    return () => {
      window.removeEventListener(OPEN_UNINSTALL_EVENT, open);
      void unlisten.then((stop) => stop());
    };
  }, []);

  // `t()` isn't reactive, so a language switch remounts everything below
  // under a new key. `activeProject` lives up here and survives it; the
  // shell is told to come back on the settings view the switch was made in.
  const language = useLanguage();
  const [shownLanguage, setShownLanguage] = useState(language);
  const [reopenSettings, setReopenSettings] = useState(false);
  if (shownLanguage !== language) {
    setShownLanguage(language);
    setReopenSettings(true);
  }

  function openProject(project: ProjectInfo) {
    setReopenSettings(false);
    setActiveProject(project);
  }

  return (
    <main className="app-shell" key={language}>
      <ToastProvider>
        <ProgressProvider>
          <ConfirmProvider>
          {activeProject ? (
            <ProjectShell
              project={activeProject}
              onBackToStart={() => {
                setReopenSettings(false);
                setActiveProject(null);
              }}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              initialBrowserTab={reopenSettings ? "settings" : undefined}
            />
          ) : (
            <>
              <StartScreen onProjectOpened={openProject} onOpeningChange={setOpeningLabel} />
              {openingLabel && (
                <div className="modal-overlay project-opening" role="status" aria-live="polite">
                  <div className="project-opening__spinner" />
                  <p className="project-opening__label">
                    {t("start.openingProjectPrefix")} „{openingLabel}"…
                  </p>
                </div>
              )}
              {isFullscreen && (
                <button
                  className="icon-btn fullscreen-exit-btn"
                  onClick={toggleFullscreen}
                  title={t("project.exitFullscreen")}
                  aria-label={t("project.exitFullscreen")}
                >
                  ⤡
                </button>
              )}
            </>
          )}
          {showWelcome && <WelcomeDialog onClose={() => setShowWelcome(false)} />}
          {showUninstall && <UninstallDialog onClose={() => setShowUninstall(false)} />}
          <BusyIndicator />
          <UpdateNotifier />
          <TextContextMenu />
          </ConfirmProvider>
        </ProgressProvider>
      </ToastProvider>
    </main>
  );
}

export default App;
