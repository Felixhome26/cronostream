import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "../../busy";
import { useConfirm } from "../../ConfirmContext";
import { usePrivacy } from "../../hooks/usePrivacyMode";
import { t } from "../../i18n";
import { useToast } from "../../ToastContext";
import type { PrivacyDetails, PrivacyScope } from "../../types";
import { comboFromEvent, formatCombo, setPrivacyCapturing, shortcutProblem } from "../../utils/privacyShortcut";
import { PasswordRecoveryForm, RecoveryCodeNotice, newPasswordProblem } from "../PrivacyPrompt";

const SCOPES: PrivacyScope[] = ["timeline", "views", "everywhere"];
const DEFAULT_SCOPE: PrivacyScope = "views";
const MASK = "••••••";
const MAX_AUTO_HIDE_MINUTES = 1440;

function errorText(e: unknown): string {
  return typeof e === "string" ? e : t("privacy.genericError");
}

function parseMinutes(value: string): number | null {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_AUTO_HIDE_MINUTES ? minutes : null;
}

/// The combination field. A captured combination is shown in the clear once,
/// to check it, and masked from the moment it is taken over. Only `canReveal`
/// can bring it back, and the section only passes that after the password.
function ShortcutField({
  value,
  canReveal,
  onAccept,
}: {
  value: string;
  canReveal: boolean;
  onAccept: (combo: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!listening) return;
    function onKeyDown(ev: KeyboardEvent) {
      // Swallowed whatever it turns out to be: nothing pressed here should
      // also act on the app behind the field.
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.key === "Escape") {
        setListening(false);
        setProblem(null);
        return;
      }
      const combo = comboFromEvent(ev);
      if (!combo) return;
      const reason = shortcutProblem(combo);
      setProblem(reason);
      if (reason) return;
      setCandidate(combo);
      setListening(false);
    }
    setPrivacyCapturing(true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      setPrivacyCapturing(false);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [listening]);

  function startListening() {
    setCandidate(null);
    setProblem(null);
    setShown(false);
    setListening(true);
  }

  function accept() {
    if (candidate) onAccept(candidate);
    setCandidate(null);
  }

  return (
    <div className="settings-row settings-row--column">
      <span className="settings-row__label">{t("privacy.shortcut")}</span>
      <span className="settings-row__hint">{t("privacy.shortcutHint")}</span>
      {listening ? (
        <div className="privacy-shortcut privacy-shortcut--listening" role="status">
          {t("privacy.shortcutListening")}
        </div>
      ) : candidate ? (
        <>
          <div className="privacy-shortcut">
            <kbd className="privacy-shortcut__keys">{formatCombo(candidate)}</kbd>
            <button type="button" className="btn btn--primary" onClick={accept}>
              {t("privacy.shortcutAccept")}
            </button>
            <button type="button" className="btn" onClick={startListening}>
              {t("privacy.shortcutRerecord")}
            </button>
          </div>
          <span className="settings-row__hint">{t("privacy.shortcutReview")}</span>
        </>
      ) : (
        <div className="privacy-shortcut">
          <kbd className="privacy-shortcut__keys">{value ? (shown ? formatCombo(value) : MASK) : t("privacy.shortcutNone")}</kbd>
          <button type="button" className="btn" onClick={startListening}>
            {t(value ? "privacy.shortcutRerecord" : "privacy.shortcutRecord")}
          </button>
          {canReveal && value && (
            <button type="button" className="btn--text" onClick={() => setShown((v) => !v)}>
              {t(shown ? "privacy.shortcutHide" : "privacy.shortcutShow")}
            </button>
          )}
        </div>
      )}
      {problem && <span className="settings-row__hint settings-row__hint--error">{t(problem)}</span>}
    </div>
  );
}

/// Note text, reach, idle time and the eye: the same fields while setting up
/// and later.
function OptionFields({
  marker,
  onMarker,
  scope,
  onScope,
  minutes,
  onMinutes,
  showIndicator,
  onShowIndicator,
}: {
  marker: string;
  onMarker: (value: string) => void;
  scope: PrivacyScope;
  onScope: (value: PrivacyScope) => void;
  minutes: string;
  onMinutes: (value: string) => void;
  showIndicator: boolean;
  onShowIndicator: (value: boolean) => void;
}) {
  return (
    <>
      <div className="settings-row settings-row--column">
        <label className="settings-row__text" htmlFor="privacy-marker">
          <span className="settings-row__label">{t("privacy.marker")}</span>
          <span className="settings-row__hint">{t("privacy.markerHint")}</span>
        </label>
        <input
          id="privacy-marker"
          className="text-input"
          value={marker}
          autoComplete="off"
          spellCheck={false}
          onChange={(ev) => onMarker(ev.target.value)}
        />
      </div>
      <div className="settings-field">
        <div className="settings-field__head">
          <span className="settings-field__title">{t("privacy.scope")}</span>
        </div>
        <div className="settings-field__options">
          {SCOPES.map((option) => (
            <label key={option} className="settings-choice">
              <input type="radio" name="privacy-scope" checked={scope === option} onChange={() => onScope(option)} />
              <span className="settings-choice__text">
                <span className="settings-row__label">{t(`privacy.scope.${option}`)}</span>
                <span className="settings-row__hint">{t(`privacy.scope.${option}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="settings-row settings-row--column">
        <label className="settings-row__text" htmlFor="privacy-auto-hide">
          <span className="settings-row__label">{t("privacy.autoHide")}</span>
          <span className="settings-row__hint">{t("privacy.autoHideHint")}</span>
        </label>
        <div className="settings-row__input-group">
          <input
            id="privacy-auto-hide"
            type="number"
            min={0}
            max={MAX_AUTO_HIDE_MINUTES}
            step={1}
            className="text-input settings-row__number"
            value={minutes}
            onChange={(ev) => onMinutes(ev.target.value)}
          />
          <span>{t("privacy.minutes")}</span>
        </div>
        {parseMinutes(minutes) === null && (
          <span className="settings-row__hint settings-row__hint--error">{t("privacy.autoHideInvalid")}</span>
        )}
      </div>
      <div className="settings-row settings-row--column">
        <label className="settings-row__checkbox">
          <input type="checkbox" checked={showIndicator} onChange={(ev) => onShowIndicator(ev.target.checked)} />
          <span>{t("privacy.showIndicator")}</span>
        </label>
        <span className="settings-row__hint">{t("privacy.showIndicatorHint")}</span>
      </div>
    </>
  );
}

function SetupForm({ onDone }: { onDone: (recoveryCode: string) => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [marker, setMarker] = useState("");
  const [scope, setScope] = useState<PrivacyScope>(DEFAULT_SCOPE);
  const [minutes, setMinutes] = useState("0");
  const [showIndicator, setShowIndicator] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);

  // The message pushes the button down, past the visible part of the
  // settings — it ended up half cut off, with nothing scrolling after it.
  useEffect(() => {
    if (error) actionsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [error]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const problem =
      newPasswordProblem(password, repeat) ?? (!shortcut ? "privacy.shortcutNone" : !marker.trim() ? "privacy.markerEmpty" : null);
    const autoHideMinutes = parseMinutes(minutes);
    if (problem || autoHideMinutes === null) {
      setError(problem ? t(problem) : t("privacy.autoHideInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await invoke<string>("privacy_setup", { password, shortcut, marker, scope, autoHideMinutes, showIndicator }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(ev) => void submit(ev)}>
      <div className="settings-group__box">
        <div className="settings-row settings-row--column">
          <label className="privacy-form__field">
            <span className="settings-row__label">{t("privacy.password")}</span>
            <span className="settings-row__hint">{t("privacy.passwordHint")}</span>
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
        </div>
        <ShortcutField value={shortcut} canReveal={false} onAccept={setShortcut} />
        <OptionFields
          marker={marker}
          onMarker={setMarker}
          scope={scope}
          onScope={setScope}
          minutes={minutes}
          onMinutes={setMinutes}
          showIndicator={showIndicator}
          onShowIndicator={setShowIndicator}
        />
        <div className="settings-row settings-row--column" ref={actionsRef}>
          {error && <span className="settings-row__hint settings-row__hint--error">{error}</span>}
          <div className="privacy-form__actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {t("privacy.setup")}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

function LockedView({ onUnlocked }: { onUnlocked: (password: string, details: PrivacyDetails) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onUnlocked(password, await invoke<PrivacyDetails>("privacy_unlock_settings", { password }));
    } catch (e) {
      setError(errorText(e));
      setPassword("");
      setBusy(false);
    }
  }

  if (recovering) {
    return (
      <div className="settings-group__box">
        <div className="settings-row settings-row--column">
          <PasswordRecoveryForm onBack={() => setRecovering(false)} onDone={() => setRecovering(false)} />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-group__box">
      <div className="settings-row settings-row--column">
        <span className="settings-row__label">{t("privacy.shortcut")}</span>
        <div className="privacy-shortcut">
          <kbd className="privacy-shortcut__keys">{MASK}</kbd>
        </div>
      </div>
      <form className="settings-row settings-row--column" onSubmit={(ev) => void submit(ev)}>
        <label className="privacy-form__field">
          <span className="settings-row__label">{t("privacy.password")}</span>
          <span className="settings-row__hint">{t("privacy.lockedHint")}</span>
          <input
            className="text-input"
            type="password"
            value={password}
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
            {t("privacy.unlock")}
          </button>
        </div>
      </form>
    </div>
  );
}

/// The unlocked section. Holds the password in memory only as long as it is
/// mounted, because the backend wants it again for every change.
function UnlockedView({
  password,
  initial,
  onPasswordChanged,
  onLock,
  onChanged,
}: {
  password: string;
  initial: PrivacyDetails;
  onPasswordChanged: (password: string) => void;
  onLock: () => void;
  onChanged: () => void;
}) {
  const [details, setDetails] = useState(initial);
  const [marker, setMarker] = useState(initial.marker);
  const [scope, setScope] = useState(initial.scope);
  const [minutes, setMinutes] = useState(String(initial.autoHideMinutes));
  const [showIndicator, setShowIndicator] = useState(initial.showIndicator);
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showToast = useToast();
  const confirm = useConfirm();

  async function apply(changes: Record<string, unknown>, doneMessage: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setDetails(await invoke<PrivacyDetails>("privacy_update_settings", { password, changes }));
      onChanged();
      showToast(doneMessage);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const parsedMinutes = parseMinutes(minutes);
  const optionsChanged =
    marker.trim() !== details.marker ||
    scope !== details.scope ||
    parsedMinutes !== details.autoHideMinutes ||
    showIndicator !== details.showIndicator;

  async function changePassword() {
    const problem = newPasswordProblem(newPassword, repeat);
    if (problem) {
      setError(t(problem));
      return;
    }
    if (await apply({ newPassword }, t("privacy.passwordChanged"))) {
      onPasswordChanged(newPassword);
      setNewPassword("");
      setRepeat("");
    }
  }

  async function disable() {
    const confirmed = await confirm({
      title: t("privacy.disableTitle"),
      body: t("privacy.disableBody"),
      confirmLabel: t("privacy.disable"),
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("privacy_disable", { password });
      onLock();
      onChanged();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-group__box">
        <ShortcutField
          value={details.shortcut}
          canReveal
          onAccept={(shortcut) => void apply({ shortcut }, t("privacy.saved"))}
        />
        <OptionFields
          marker={marker}
          onMarker={setMarker}
          scope={scope}
          onScope={setScope}
          minutes={minutes}
          onMinutes={setMinutes}
          showIndicator={showIndicator}
          onShowIndicator={setShowIndicator}
        />
        <div className="settings-row settings-row--column">
          <div className="privacy-form__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !optionsChanged || parsedMinutes === null || !marker.trim()}
              onClick={() => void apply({ marker, scope, autoHideMinutes: parsedMinutes, showIndicator }, t("privacy.saved"))}
            >
              {t("privacy.save")}
            </button>
          </div>
        </div>
      </div>
      <div className="settings-group__box">
        <div className="settings-row settings-row--column">
          <label className="privacy-form__field">
            <span className="settings-row__label">{t("privacy.newPassword")}</span>
            <input
              className="text-input"
              type="password"
              value={newPassword}
              autoComplete="new-password"
              onChange={(ev) => setNewPassword(ev.target.value)}
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
          <div className="privacy-form__actions">
            <button type="button" className="btn" disabled={busy || !newPassword} onClick={() => void changePassword()}>
              {t("privacy.changePassword")}
            </button>
          </div>
        </div>
      </div>
      {error && <span className="settings-row__hint settings-row__hint--error">{error}</span>}
      <div className="privacy-form__actions privacy-form__actions--spread">
        <button type="button" className="btn--text" disabled={busy} onClick={() => void disable()}>
          {t("privacy.disable")}
        </button>
        <button type="button" className="btn" onClick={onLock}>
          {t("privacy.lock")}
        </button>
      </div>
    </>
  );
}

/// "Privatsphäre" in the settings: set up once, then everything in here sits
/// behind the password. No scope control, unlike the settings around it: this
/// always belongs to the one stream.
export default function PrivacySection() {
  const privacy = usePrivacy();
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<{ password: string; details: PrivacyDetails } | null>(null);

  if (!privacy?.status) return null;

  return (
    <section className="settings-group">
      <p className="settings-group__intro">{t("privacy.intro")}</p>
      {issuedCode ? (
        <div className="settings-group__box">
          <div className="settings-row settings-row--column">
            <RecoveryCodeNotice code={issuedCode} onDone={() => setIssuedCode(null)} />
          </div>
        </div>
      ) : !privacy.status.configured ? (
        <SetupForm
          onDone={(code) => {
            setIssuedCode(code);
            privacy.onSettingsChanged();
          }}
        />
      ) : unlocked ? (
        <UnlockedView
          password={unlocked.password}
          initial={unlocked.details}
          onPasswordChanged={(password) => setUnlocked((prev) => (prev ? { ...prev, password } : prev))}
          onLock={() => setUnlocked(null)}
          onChanged={privacy.onSettingsChanged}
        />
      ) : (
        <LockedView onUnlocked={(password, details) => setUnlocked({ password, details })} />
      )}
    </section>
  );
}
