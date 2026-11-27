import { useState } from "react";
import { invoke } from "../../busy";
import { t, tn } from "../../i18n";
import { useProgress } from "../../ProgressContext";
import { useToast } from "../../ToastContext";
import { formatBytes } from "../DeleteStreamDialog";

interface Finding {
  id: string | null;
  name: string;
  path: string;
}

interface ArchiveReport {
  itemsChecked: number;
  missingFiles: Finding[];
  missingFilesCount: number;
  missingThumbnails: Finding[];
  missingThumbnailsCount: number;
  strayFiles: Finding[];
  strayFilesCount: number;
  strayBytes: number;
  changedFiles: Finding[];
  changedFilesCount: number;
  contentsChecked: boolean;
  fingerprintsAdded: number;
}

/// "Archiv prüfen" under "Verwalten": a read-only health check of the open
/// stream (see `archive_check.rs`). The only thing it can repair is a
/// missing thumbnail, and only when asked.
export default function ArchiveTab({ onDataChanged }: { onDataChanged?: () => void }) {
  const { startOperation, finishOperation } = useProgress();
  const showToast = useToast();
  const [deep, setDeep] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ArchiveReport | null>(null);

  async function check(readContents: boolean): Promise<ArchiveReport | null> {
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("archive.progressLabel"), total: 0 });
    try {
      return await invoke<ArchiveReport>("check_archive", { deep: readContents, operationId });
    } catch (e) {
      showToast(typeof e === "string" ? e : t("archive.error"));
      return null;
    } finally {
      finishOperation(operationId);
    }
  }

  async function run() {
    setRunning(true);
    const result = await check(deep);
    if (result) setReport(result);
    setRunning(false);
  }

  /// Every missing thumbnail in one go (the backend finds them all, not only
  /// the listed ones), then a quick check for the new state: the files are
  /// not read again, and what a full check found about contents stays.
  async function regenerateThumbnails() {
    if (!report) return;
    setRunning(true);
    const operationId = crypto.randomUUID();
    startOperation({ id: operationId, label: t("archive.thumbnailsProgress"), total: report.missingThumbnailsCount });
    try {
      const made = await invoke<number>("regenerate_thumbnails", { operationId });
      showToast(tn(made, "archive.thumbnailsDone"));
      onDataChanged?.();
    } catch (e) {
      showToast(typeof e === "string" ? e : t("archive.error"));
    } finally {
      finishOperation(operationId);
    }
    const fresh = await check(false);
    if (fresh) {
      setReport((previous) =>
        previous?.contentsChecked
          ? {
              ...fresh,
              contentsChecked: true,
              changedFiles: previous.changedFiles,
              changedFilesCount: previous.changedFilesCount,
              fingerprintsAdded: previous.fingerprintsAdded,
            }
          : fresh,
      );
    }
    setRunning(false);
  }

  return (
    <div className="archive-tab">
      <p className="duplicates-tab__hint">{t("archive.hint")}</p>
      <label className="archive-tab__deep">
        <input type="checkbox" checked={deep} onChange={(ev) => setDeep(ev.target.checked)} disabled={running} />
        <span>
          {t("archive.deepLabel")}
          <small>{t("archive.deepHint")}</small>
        </span>
      </label>
      <button className="btn btn--primary" onClick={() => void run()} disabled={running}>
        {running ? t("archive.progressLabel") : t("archive.button")}
      </button>

      {report && (
        <div className="archive-tab__report">
          <p className="archive-tab__summary">
            {tn(report.itemsChecked, "archive.checked")}
            {report.contentsChecked && report.fingerprintsAdded > 0 && (
              <> · {tn(report.fingerprintsAdded, "archive.fingerprintsAdded")}</>
            )}
          </p>
          <Section ok={report.missingFilesCount === 0} title={t("archive.missingFiles")} count={report.missingFilesCount} items={report.missingFiles}>
            {t("archive.missingFilesHint")}
          </Section>
          <Section
            ok={report.missingThumbnailsCount === 0}
            title={t("archive.missingThumbnails")}
            count={report.missingThumbnailsCount}
            items={report.missingThumbnails}
          >
            <button className="btn" onClick={() => void regenerateThumbnails()} disabled={running}>
              {t("archive.regenerate")}
            </button>
          </Section>
          <Section
            ok={report.strayFilesCount === 0}
            title={`${t("archive.strayFiles")}${report.strayBytes > 0 ? ` (${formatBytes(report.strayBytes)})` : ""}`}
            count={report.strayFilesCount}
            items={report.strayFiles}
          >
            {t("archive.strayFilesHint")}
          </Section>
          {report.contentsChecked ? (
            <Section ok={report.changedFilesCount === 0} title={t("archive.changedFiles")} count={report.changedFilesCount} items={report.changedFiles}>
              {t("archive.changedFilesHint")}
            </Section>
          ) : (
            <p className="archive-tab__note">{t("archive.contentsNotChecked")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  ok,
  title,
  count,
  items,
  children,
}: {
  ok: boolean;
  title: string;
  count: number;
  items: Finding[];
  children?: React.ReactNode;
}) {
  return (
    <section className={"archive-tab__section" + (ok ? " archive-tab__section--ok" : " archive-tab__section--warn")}>
      <h3>
        {ok ? "✓" : "⚠"} {title}: {count}
      </h3>
      {!ok && (
        <>
          <div className="archive-tab__section-hint">{children}</div>
          <details>
            <summary>{t("archive.showList")}</summary>
            <ul className="archive-tab__list">
              {items.map((item) => (
                <li key={item.path} title={item.path}>
                  <strong>{item.name}</strong> <span>{item.path}</span>
                </li>
              ))}
              {count > items.length && <li>{t("archive.more").replace("{count}", String(count - items.length))}</li>}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
