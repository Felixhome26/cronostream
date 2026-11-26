import { confidenceLabel, t, timestampSourceLabel } from "../../i18n";
import type { AiSuggestion } from "../../types";
import { formatDateTime } from "../../utils/datetime";

interface Props {
  suggestion: AiSuggestion;
  onClose: () => void;
}

function formatFull(iso: string | null): string {
  return formatDateTime(iso) ?? "–";
}

/// Opened by clicking a row's reason text on the AI metadata review screen —
/// shows every date candidate the backend knows about for that file (not
/// just the one the AI picked), so the user can judge the suggestion
/// themselves instead of taking it on faith.
export default function AiSuggestionDetail({ suggestion: s, onClose }: Props) {
  return (
    <div className="review-modal__backdrop" onClick={onClose}>
      <div className="ai-suggestion-detail" onClick={(e) => e.stopPropagation()}>
        <div className="review-modal__header">
          <h2 title={s.original_filename ?? s.id}>{s.original_filename ?? s.id}</h2>
          <button className="btn--text" onClick={onClose}>
            {t("browser.review.close")}
          </button>
        </div>

        <dl className="ai-suggestion-detail__list">
          <dt>{t("browser.aiMetadata.detailFolder")}</dt>
          <dd>{s.source_folder_path ?? "–"}</dd>

          <dt>{t("browser.aiMetadata.detailCurrent")}</dt>
          <dd>
            {formatFull(s.current_timestamp)}
            {s.current_timestamp_source && ` (${timestampSourceLabel(s.current_timestamp_source)})`}
          </dd>

          <dt>{t("browser.aiMetadata.detailEmbedded")}</dt>
          <dd>{formatFull(s.embedded_metadata_at)}</dd>

          <dt>{t("browser.aiMetadata.detailFsCreated")}</dt>
          <dd>{formatFull(s.fs_created_at)}</dd>

          <dt>{t("browser.aiMetadata.detailFsModified")}</dt>
          <dd>{formatFull(s.fs_modified_at)}</dd>

          <dt>{t("browser.aiMetadata.detailSuggested")}</dt>
          <dd>
            {formatFull(s.suggested_timestamp)}
            {s.confidence && ` (${confidenceLabel(s.confidence)})`}
          </dd>

          <dt>{t("browser.aiMetadata.colReason")}</dt>
          <dd>{s.reason ?? "–"}</dd>
        </dl>
      </div>
    </div>
  );
}
