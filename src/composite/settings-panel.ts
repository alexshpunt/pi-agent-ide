import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";

/** Two settings tabs share staged choices; saving and canceling are explicit. */
export function createSettingsPanel(
  theme: Theme,
  items: () => { modules: SettingItem[]; features: SettingItem[]; ui?: SettingItem[] },
  change: (tab: "modules" | "features" | "ui", id: string, value: string) => void,
  done: (save: boolean) => void,
  scope = "",
) {
  const tabs = ["modules", "features", "ui"] as const;
  let tab: (typeof tabs)[number] = "modules";
  const createList = () => {
    const entries = items()[tab] ?? [];
    return new SettingsList(
      entries,
      12,
      getSettingsListTheme(),
      (id, value) => {
        change(tab, id, value);
        for (const next of items()[tab] ?? []) {
          const entry = entries.find((item) => item.id === next.id);
          if (entry) Object.assign(entry, next);
        }
      },
      () => done(false),
      { enableSearch: true },
    );
  };
  let list = createList();
  return {
    render(width: number): string[] {
      return [
        ...new Text(
          theme.fg("accent", theme.bold(`Agent IDE settings${scope ? ` · ${scope}` : ""}`)),
          1,
          0,
        ).render(width),
        ...new Text(
          tabs
            .map((id) => {
              const label = id === "ui" ? "UI" : id === "modules" ? "Modules" : "Features";
              return id === tab ? `[${label}]` : label;
            })
            .join("   "),
          1,
          0,
        ).render(width),
        ...list.render(width),
        ...new Text(
          theme.fg("dim", "Tab: switch tab · Enter: change · Ctrl+S: save · Esc: cancel"),
          1,
          0,
        ).render(width),
      ];
    },
    invalidate(): void {
      list.invalidate();
    },
    handleInput(data: string): void {
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        tab =
          tabs[(tabs.indexOf(tab) + (matchesKey(data, "shift+tab") ? 2 : 1)) % tabs.length] ??
          "modules";
        list = createList();
      } else if (matchesKey(data, "ctrl+s")) done(true);
      else list.handleInput(data);
    },
  };
}
