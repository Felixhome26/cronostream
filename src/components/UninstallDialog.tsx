import { useEffect, useMemo, useState } from "react";
import { invoke } from "../busy";
import { t } from "../i18n";
import type { UninstallPlan, UninstallTarget, UninstallTargetKind } from "../types";
import { formatBytes } from "./DeleteStreamDialog";

/// As in DeleteStreamDialog: the final button stays locked this long.
const COUNTDOWN_SECONDS = 5;

/// Opens the dialog from anywhere in the frontend (the settings row); the
/// start menu entry reaches it through the backend (`uninstall.rs`).
export const OPEN_UNINSTALL_EVENT = "cronostream:open-uninstall";

export function openUninstallDialog() {
  window.dispatchEvent(new Event(OPEN_UNINSTALL_EVENT));
}

/// The order the kinds are listed in, program first.
const KIND_ORDER: UninstallTargetKind[] = [
  "program",
  "settings",
  "webview",
  "cache",
  "recordings",
  "menu",
  "startMenu",
  "autostart",
  "legacy",
];

function groupTargets(targets: UninstallTarget[]) {
  return KIND_ORDER.map((kind) => ({ kind, targets: targets.filter((target) => target.kind === kind) })).filter(
    (group) => group.targets.length > 0,
  );
}

/// Removing CronoStream from the computer, for "CronoStream vollständig
/// entfernen" in the settings and the start menu entry "CronoStream
/// deinstallieren". Lists everything that goes, keeps the streams unless
/// ticked one by one, and asks twice with the same countdown as deleting a
/// stream.
export default function UninstallDialog({ onClose }: { onClose: () => void }) {
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [step, setStep] = useState<"details" | "final" | "closing">("details");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [deleteAppimage, setDeleteAppimage] = useState(false);
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<UninstallPlan>("get_uninstall_plan")
      .then(setPlan)
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (step !== "final") {
      setRemaining(COUNTDOWN_SECONDS);
      return;
    }
    const timer = window.setInterval(() => {
      setRemaining((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const groups = useMemo(() => groupTargets(plan?.targets ?? []), [plan]);
  const chosenStreams = plan?.streams.filter((stream) => chosen.has(stream.path)) ?? [];

  function toggleStream(path: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function runUninstall() {
    setBusy(true);
    setError(null);
    try {
      await invoke("run_uninstall", {
        streams: chosenStreams.map((stream) => stream.path),
        deleteAppimage: deleteAppimage && plan?.appimage != null,
      });
      setStep("closing");
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  if (!plan) {
    return (
      <div className="modal-overlay modal-overlay--above-settings">
        <div className="modal-card">
          <h3 className="modal-card__title">{t("uninstall.title")}</h3>
          <p className="modal-card__body">{error ?? t("uninstall.loading")}</p>
          {error && (
            <div className="modal-card__actions">
              <button className="btn--text" onClick={onClose}>
                {t("delete.close")}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!plan.available) {
    return (
      <div className="modal-overlay modal-overlay--above-settings">
        <div className="modal-card">
          <h3 className="modal-card__title">{t("uninstall.title")}</h3>
          <p className="modal-card__body">{plan.unavailableReason}</p>
          <div className="modal-card__actions">
            <button className="btn--text" onClick={onClose}>
              {t("delete.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "closing") {
    return (
      <div className="modal-overlay modal-overlay--above-settings">
        <div className="modal-card">
          <p className="modal-card__body">{t("uninstall.closing")}</p>
        </div>
      </div>
    );
  }

  const isWindows = plan.platform === "windows";

  return (
    <div className="modal-overlay modal-overlay--above-settings">
      <div className="modal-card modal-card--wide uninstall-dialog">
        {step === "details" ? (
          <>
            <h3 className="modal-card__title">{t("uninstall.title")}</h3>
            <p className="modal-card__body">
              {t("uninstall.intro")}
              {isWindows && ` ${t("uninstall.introWindows")}`}
            </p>

            <h4 className="uninstall-dialog__heading">{t("uninstall.removedHeading")}</h4>
            <ul className="uninstall-dialog__targets">
              {groups.map((group) => (
                <li key={group.kind}>
                  <span className="uninstall-dialog__kind">
                    {t(`uninstall.kind.${group.kind}`)}
                    {group.targets.some((target) => target.sizeBytes > 0) &&
                      ` (${formatBytes(group.targets.reduce((sum, target) => sum + target.sizeBytes, 0))})`}
                  </span>
                  {group.targets.map((target) => (
                    <span key={target.path} className="uninstall-dialog__path">
                      {target.path}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            {plan.keptDeletedStreams > 0 && (
              <p className="delete-dialog__error">
                {t("uninstall.keptDeleted").replace("{n}", String(plan.keptDeletedStreams))}
              </p>
            )}

            <h4 className="uninstall-dialog__heading">{t("uninstall.streamsHeading")}</h4>
            <p className="modal-card__hint uninstall-dialog__hint">{t("uninstall.streamsHint")}</p>
            {plan.streams.length === 0 ? (
              <p className="modal-card__hint uninstall-dialog__hint">{t("uninstall.streamsEmpty")}</p>
            ) : (
              <div className="uninstall-dialog__streams">
                {plan.streams.map((stream) => (
                  <label key={stream.path} className="delete-dialog__keep uninstall-dialog__choice">
                    <input
                      type="checkbox"
                      checked={chosen.has(stream.path)}
                      onChange={() => toggleStream(stream.path)}
                    />
                    <span>
                      <strong>
                        {stream.name} ({formatBytes(stream.sizeBytes)})
                      </strong>
                      <span className="uninstall-dialog__path">{stream.path}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="modal-card__hint uninstall-dialog__hint">{t("uninstall.streamsElsewhere")}</p>

            {plan.appimage && (
              <label className="delete-dialog__keep uninstall-dialog__choice">
                <input
                  type="checkbox"
                  checked={deleteAppimage}
                  onChange={(ev) => setDeleteAppimage(ev.target.checked)}
                />
                <span>
                  <strong>{t("uninstall.appimage")}</strong>
                  <span className="uninstall-dialog__path">{plan.appimage}</span>
                  <span className="modal-card__hint delete-dialog__keep-hint">{t("uninstall.appimageHint")}</span>
                </span>
              </label>
            )}

            <div className="modal-card__actions">
              <button className="btn--text" onClick={onClose}>
                {t("delete.cancel")}
              </button>
              <button className="btn btn--danger" onClick={() => setStep("final")}>
                {t("delete.next")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="modal-card__title">{t("uninstall.finalTitle")}</h3>
            <p className="modal-card__body">{t("uninstall.finalData")}</p>
            {chosenStreams.length > 0 ? (
              <div className="delete-dialog__foreign">
                <p>{t("uninstall.finalStreams")}</p>
                <ul>
                  {chosenStreams.map((stream) => (
                    <li key={stream.path}>
                      {stream.name} – {stream.path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="modal-card__body">{t("uninstall.finalNoStreams")}</p>
            )}
            {plan.appimage && (
              <p className="modal-card__body">
                {deleteAppimage ? (
                  t("uninstall.finalAppimage")
                ) : (
                  <>
                    {t("uninstall.finalAppimageKept")} <strong>{plan.appimage}</strong>
                  </>
                )}
              </p>
            )}
            {isWindows && <p className="modal-card__body">{t("uninstall.finalWindows")}</p>}
            {error && <p className="delete-dialog__error uninstall-dialog__error">{error}</p>}
            <div className="modal-card__actions">
              <button className="btn--text" onClick={() => setStep("details")} disabled={busy}>
                {t("delete.back")}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void runUninstall()}
                disabled={busy || remaining > 0}
              >
                {remaining > 0 ? `${t("uninstall.confirm")} (${remaining})` : t("uninstall.confirm")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
