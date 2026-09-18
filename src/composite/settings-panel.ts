import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SettingsList,
  truncateToWidth,
  visibleWidth,
  type SettingItem,
} from "@earendil-works/pi-tui";

type SettingsTab = "extensions" | "behavior" | "ui";
type SettingsItems = { modules: SettingItem[]; features: SettingItem[]; ui?: SettingItem[] };

/** Render staged Agent IDE settings in one bordered, keyboard-driven panel. */
export function createSettingsPanel(
  theme: Theme,
  items: () => SettingsItems,
  change: (tab: "modules" | "features" | "ui", id: string, value: string) => void,
  done: (save: boolean) => void,
  scope = "",
) {
  const tabs = ["extensions", "behavior", "ui"] as const;
  let tab: SettingsTab = "extensions";
  const itemKey = (selected: SettingsTab): keyof SettingsItems =>
    selected === "extensions" ? "modules" : selected === "behavior" ? "features" : "ui";
  const changeKey = (selected: SettingsTab): "modules" | "features" | "ui" =>
    selected === "extensions" ? "modules" : selected === "behavior" ? "features" : "ui";
  const createList = () => {
    const key = itemKey(tab);
    const entries = items()[key] ?? [];
    return new SettingsList(
      entries,
      12,
      getSettingsListTheme(),
      (id, value) => {
        change(changeKey(tab), id, value);
        for (const next of items()[key] ?? []) {
          const entry = entries.find((item) => item.id === next.id);
          if (entry) Object.assign(entry, next);
        }
      },
      () => done(false),
      { enableSearch: true },
    );
  };
  let list = createList();

  const border = (value: string) => theme.fg("borderMuted", value);
  const row = (content: string, width: number): string => {
    if (width <= 1) return border("│");
    const inner = width - 2;
    const clipped = truncateToWidth(content, inner);
    return `${border("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border("│")}`;
  };
  const rule = (width: number): string =>
    border(width <= 1 ? "├" : `├${"─".repeat(Math.max(0, width - 2))}┤`);

  return {
    render(width: number): string[] {
      const panelWidth = Math.max(1, width);
      const innerWidth = Math.max(1, panelWidth - 4);
      const title = ` Agent IDE settings${scope ? ` · ${scope}` : ""} `;
      const top =
        panelWidth <= 1
          ? border("╭")
          : `${border("╭─")}${theme.fg("accent", theme.bold(truncateToWidth(title, Math.max(0, panelWidth - 3), "")))}${border(`${"─".repeat(Math.max(0, panelWidth - visibleWidth(title) - 3))}╮`)}`;
      const labels: Record<SettingsTab, string> = {
        extensions: "Features",
        behavior: "Behavior",
        ui: "UI",
      };
      const tabLine = tabs
        .map((id) =>
          id === tab
            ? theme.fg("accent", theme.bold(`[ ${labels[id]} ]`))
            : theme.fg("dim", `  ${labels[id]}  `),
        )
        .join(" ");
      const body = list.render(innerWidth).map((line) => row(` ${line} `, panelWidth));
      const help = theme.fg("dim", " Tab switch  ·  Enter change  ·  Ctrl+S save  ·  Esc cancel ");
      return [
        top,
        row(` ${tabLine} `, panelWidth),
        rule(panelWidth),
        ...body,
        rule(panelWidth),
        row(help, panelWidth),
        border(panelWidth <= 1 ? "╰" : `╰${"─".repeat(Math.max(0, panelWidth - 2))}╯`),
      ];
    },
    invalidate(): void {
      list.invalidate();
    },
    handleInput(data: string): void {
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        tab =
          tabs[(tabs.indexOf(tab) + (matchesKey(data, "shift+tab") ? 2 : 1)) % tabs.length] ??
          "extensions";
        list = createList();
      } else if (matchesKey(data, "ctrl+s")) done(true);
      else list.handleInput(data);
    },
  };
}
