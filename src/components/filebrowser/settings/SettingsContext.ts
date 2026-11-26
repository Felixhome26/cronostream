import { createContext, useContext } from "react";
import type { ProjectSettings, SettingScope } from "../../../types";

export interface SettingsContextValue {
  settings: ProjectSettings;
  onChange: (patch: Partial<ProjectSettings>) => void;
  onScopeChange: (keys: string[], scope: SettingScope) => void;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

/// What every category reads and writes through, so the rows don't have to be
/// handed the project settings and both callbacks one by one.
export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings outside SettingsContext");
  return value;
}
