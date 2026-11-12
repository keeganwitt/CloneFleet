import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AppSettings, SettingsView, Theme } from "./types";

export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    void getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch(() => {});
  } catch {
    // Outside a Tauri window (tests, plain browser) there is no native title bar to theme.
  }
}

export function useSettings() {
  const [view, setView] = useState<SettingsView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.getSettings().then(
      (loaded) => {
        setView(loaded);
        applyTheme(loaded.settings.theme);
      },
      (failure) => setError(String(failure)),
    );
  }, []);

  const save = useCallback(async (settings: AppSettings) => {
    const saved = await api.setSettings(settings);
    setView(saved);
    applyTheme(saved.settings.theme);
    return saved;
  }, []);

  return { view, error, save };
}
