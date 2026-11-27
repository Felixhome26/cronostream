import { useEffect, useState } from "react";
import { invoke } from "../../busy";
import type { RecentProjectEntry } from "../../types";
import { quoted, t, tf } from "../../i18n";
import { useToast } from "../../ToastContext";

interface Props {
  /// Files to put on the chosen stream's waiting list.
  paths: string[];
  /// Called once a stream was picked (or the list was left) so the
  /// surrounding context menu can close itself.
  onDone: () => void;
}

/// The "in anderen Stream einfügen" entry of the file manager's context
/// menus. Clicking it swaps the menu content for the list of the other
/// recent streams; picking one queues the files on *that* stream's
/// waiting list, where they are offered for adding the next time it is
/// opened (see `pending_drops::add_pending_drops_to_project`).
export default function SendToProjectItems({ paths, onDone }: Props) {
  const showToast = useToast();
  const [projects, setProjects] = useState<RecentProjectEntry[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    invoke<RecentProjectEntry[]>("list_other_projects")
      .then((list) => !cancelled && setProjects(list))
      .catch(() => !cancelled && setProjects([]));
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  async function send(project: RecentProjectEntry) {
    onDone();
    try {
      const queued = await invoke<number>("add_pending_drops_to_project", {
        projectPath: project.path,
        paths,
      });
      showToast(
        queued > 0
          ? `${tf("browser.sendToProjectDone", { name: quoted(project.name) })} (${queued})`
          : t("browser.sendToProjectAlready"),
      );
    } catch (err) {
      showToast(String(err));
    }
  }

  if (!expanded) {
    return (
      <button
        className="context-menu__item"
        onClick={(ev) => {
          ev.stopPropagation();
          setExpanded(true);
        }}
      >
        {t("browser.sendToProject")} ▸
      </button>
    );
  }

  return (
    <>
      <div className="context-menu__label">{t("browser.sendToProjectPick")}</div>
      {projects === null && <div className="context-menu__label">…</div>}
      {projects?.length === 0 && <div className="context-menu__label">{t("browser.sendToProjectNone")}</div>}
      {projects?.map((p) => (
        <button key={p.path} className="context-menu__item" title={p.path} onClick={() => send(p)}>
          📚 {p.name}
        </button>
      ))}
    </>
  );
}
