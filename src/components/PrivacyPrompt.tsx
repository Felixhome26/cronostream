import { useState, type FormEvent } from "react";
import { invoke } from "../busy";
import { t } from "../i18n";

const MIN_PASSWORD_CHARS = 4;

function errorText(e: unknown): string {
  return typeof e === "string" ? e : t("privacy.genericError");
}

/// The one thing a new password's two fields can get wrong, as an i18n key.
export function newPasswordProblem(password: string, repeat: string): string | null {
  if ([...password].length < MIN_PASSWORD_CHARS) return "privacy.passwordTooShort";
  if (password !== repeat) return "privacy.passwordMismatch";
  return null;
}

/// A freshly issued recovery code. It exists in the clear only here: the
/// backend keeps nothing but its hash, so this is the one chance to note it.
export function RecoveryCodeNotice({ code, onDone }: { code: string; onDone: () => void }) {
  return (
    <div className="privacy-code">
      <span className="settings-row__label">{t("privacy.recoveryTitle")}</span>
      <span className="settings-row__hint">{t("privacy.recoveryExplain")}</span>
      <code className="privacy-code__value">{code}</code>
      <button type="button" className="btn btn--primary" onClick={onDone}>
        {t("privacy.recoveryDone")}
      </button>
    </div>
  );
}

/// "Passwort vergessen": a new password against the recovery code. Used up
/// by this, so a new code is issued and shown right away.
export function PasswordRecoveryForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextCode, setNextCode] = useState<string | null>(null);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const problem = newPasswordProblem(password, repeat);
    if (problem) {
      setError(t(problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setNextCode(await invoke<string>("privacy_reset_password", { recoveryCode: code, newPassword: password }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (nextCode) {
    return (
      <>
        <span className="settings-row__hint">{t("privacy.resetSuccess")}</span>
        <RecoveryCodeNotice code={nextCode} onDone={onDone} />
      </>
    );
  }

  return (
    <form className="privacy-form" onSubmit={(ev) => void submit(ev)}>
      <label className="privacy-form__field">
        <span className="settings-row__label">{t("privacy.recoveryTitle")}</span>
        <input
          className="text-input"
          value={code}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(ev) => setCode(ev.target.value)}
        />
      </label>
      <label className="privacy-form__field">
        <span className="settings-row__label">{t("privacy.newPassword")}</span>
        <input
          className="text-input"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(ev) => setPassword(ev.target.value)}
        />
      </label>
      <label className="privacy-form__field">
        <span className="settings-row__label">{t("privacy.passwordRepeat")}</span>
        <input
          className="text-input"
          type="password"
          value={repeat}
          autoComplete="new-password"
          onChange={(ev) => setRepeat(ev.target.value)}
        />
      </label>
      {error && <span className="settings-row__hint settings-row__hint--error">{error}</span>}
      <div className="privacy-form__actions">
        <button type="button" className="btn" onClick={onBack}>
          {t("privacy.back")}
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !code.trim()}>
          {t("privacy.resetPassword")}
        </button>
      </div>
    </form>
  );
}

/// Asks for the password before private files come back. Hiding them never
/// comes through here.
export default function PrivacyPrompt({
  onSubmit,
  onClose,
}: {
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (e) {
      setError(errorText(e));
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <div
      className="diary-modal privacy-modal"
      onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}
      onKeyDown={(ev) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        onClose();
      }}
    >
      <div className="diary-modal__panel diary-modal__panel--narrow" role="dialog" aria-modal="true" aria-label={t("privacy.promptTitle")}>
        <div className="diary-modal__header">
          <div className="diary-modal__title">{t("privacy.promptTitle")}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("record.close")}>
            ✕
          </button>
        </div>
        <div className="diary-modal__body">
          {recovering ? (
            <PasswordRecoveryForm onBack={() => setRecovering(false)} onDone={() => setRecovering(false)} />
          ) : (
            <form className="privacy-form" onSubmit={(ev) => void submit(ev)}>
              <label className="privacy-form__field">
                <span className="settings-row__label">{t("privacy.password")}</span>
                <input
                  className="text-input"
                  type="password"
                  value={password}
                  autoFocus
                  autoComplete="off"
                  onChange={(ev) => setPassword(ev.target.value)}
                />
              </label>
              {error && <span className="settings-row__hint settings-row__hint--error">{error}</span>}
              <div className="privacy-form__actions privacy-form__actions--spread">
                <button type="button" className="btn--text" onClick={() => setRecovering(true)}>
                  {t("privacy.forgot")}
                </button>
                <button type="submit" className="btn btn--primary" disabled={busy || !password}>
                  {t("privacy.promptButton")}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/// Bottom-left corner, in view while the mode is set up unless turned off in
/// the settings: an open eye with everything showing, a crossed-out one while
/// private files are hidden.
export function PrivacyIndicator({ revealed }: { revealed: boolean }) {
  const label = t(revealed ? "privacy.indicatorAll" : "privacy.indicatorHidden");
  return (
    <div className={"privacy-indicator" + (revealed ? "" : " privacy-indicator--hidden")} role="status" title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
        {!revealed && <line x1="4" y1="4" x2="20" y2="20" />}
      </svg>
    </div>
  );
}
