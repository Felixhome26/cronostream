import { t } from "../../i18n";

interface Props {
  /// Triggers the backup (folder picker + `start_backup`) — owned by
  /// `ProjectShell`, since the `CopyProgress` overlay it starts renders
  /// there, outside the file-browser overlay this tab lives inside.
  /// `true` brings an existing backup up to date instead of writing a new one.
  onBackup: (update: boolean) => void;
  backupBusy: boolean;
}

/// Manual full-project backup, moved here from a Settings row so it sits
/// alongside Protokoll under "Verwalten" — both are project-maintenance
/// actions, not everyday settings.
export default function BackupTab({ onBackup, backupBusy }: Props) {
  return (
    <div className="backup-tab">
      <p className="backup-tab__hint">{t("settings.backupHint")}</p>
      <button className="btn btn--primary" onClick={() => onBackup(false)} disabled={backupBusy}>
        {t("project.backup")}
      </button>
      <p className="backup-tab__hint">{t("project.backupUpdateHint")}</p>
      <button className="btn" onClick={() => onBackup(true)} disabled={backupBusy}>
        {t("project.backupUpdate")}
      </button>
    </div>
  );
}
