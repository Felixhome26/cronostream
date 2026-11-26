import { useEffect, useState } from "react";
import { invoke } from "../../busy";
import { t } from "../../i18n";
import { useToast } from "../../ToastContext";

interface RevealTargets {
  stored_path: string | null;
  source_path: string | null;
  source_exists: boolean;
}

interface Props {
  /// A stream item id, or a file path that is either an item's stored
  /// copy or its source file. A path unknown to the stream gets the
  /// single plain "show in folder" entry.
  itemId?: string;
  path?: string;
  onDone: () => void;
  className?: string;
}

/// The "im Ordner anzeigen" entries of the context menus: one for the copy
/// in the stream folder, one for the original source folder — which is
/// disabled and labelled when the source is gone.
export default function RevealInFolderItems({ itemId, path, onDone, className = "context-menu__item" }: Props) {
  const showToast = useToast();
  const [targets, setTargets] = useState<RevealTargets | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<RevealTargets>("get_reveal_targets", { id: itemId ?? null, path: path ?? null })
      .then((r) => alive && setTargets(r))
      .catch(() => alive && setTargets({ stored_path: null, source_path: null, source_exists: false }));
    return () => {
      alive = false;
    };
  }, [itemId, path]);

  async function reveal(target: string) {
    onDone();
    try {
      await invoke("reveal_in_folder", { path: target });
    } catch {
      showToast(t("browser.openExternallyFailed"));
    }
  }

  if (!targets) return null;
  if (!targets.stored_path) {
    return path ? (
      <button className={className} onClick={() => reveal(path)}>
        {t("browser.revealInFolder")}
      </button>
    ) : null;
  }
  return (
    <>
      <button className={className} onClick={() => reveal(targets.stored_path!)}>
        📂 {t("reveal.inStream")}
      </button>
      {targets.source_path && (
        <button
          className={className}
          disabled={!targets.source_exists}
          title={targets.source_exists ? undefined : t("reveal.sourceMissingHint")}
          onClick={() => reveal(targets.source_path!)}
        >
          📂 {t("reveal.inSource")}
          {!targets.source_exists && ` (${t("reveal.sourceMissing")})`}
        </button>
      )}
    </>
  );
}
