import { createHash } from "node:crypto";

import {
  connectTipProvider,
  TIP_API_VERSION,
  TIP_PROTOCOL,
  type TipContext,
  type TipProvider,
} from "#src/api/tips.js";

import type { DoctorSetupRun } from "./run.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DOCTOR_TIP_PROVIDER_ID = "doctor";
const MAX_VISIBLE_ITEMS = 3;

/** Registers actionable doctor startup guidance with the built-in tip core. */
export function registerDoctorTipProvider(
  pi: ExtensionAPI,
  inspect: (context: TipContext) => Promise<DoctorSetupRun>,
): void {
  const registration = connectTipProvider(pi, createDoctorTipProvider(inspect));
  if (registration !== undefined) {
    void registration.catch(() => {});
  }
}

/** Creates a provider whose identity follows the current actionable setup state. */
export function createDoctorTipProvider(
  inspect: (context: TipContext) => Promise<DoctorSetupRun>,
): TipProvider {
  return {
    protocol: TIP_PROTOCOL,
    apiVersion: TIP_API_VERSION,
    id: DOCTOR_TIP_PROVIDER_ID,
    async getTip(context) {
      const result = await inspect(context);
      const items = setupItems(result);
      if (items.length === 0) {
        return undefined;
      }

      const visible = items.slice(0, MAX_VISIBLE_ITEMS).map((item) => `• ${item.message}`);
      if (items.length > MAX_VISIBLE_ITEMS) {
        visible.push(`• ${items.length - MAX_VISIBLE_ITEMS} more`);
      }

      return {
        id: `doctor-setup-${fingerprint(items)}`,
        title:
          items.length === 1
            ? "Project setup needs attention"
            : `${items.length} project setup items`,
        body: [...visible, "Run /pi-agent-ide-doctor"].join("\n"),
      };
    },
  };
}

interface SetupItem {
  readonly id: string;
  readonly message: string;
}

function setupItems(result: DoctorSetupRun): readonly SetupItem[] {
  const actions = result.actions.map((action) => ({
    id: `action:${action.pluginId}:${action.id}`,
    message: action.message,
  }));
  const suggestions = result.suggestions.map((suggestion) => {
    const languages = suggestion.recipe.languages
      .filter((language) => result.detectedLanguages.has(language))
      .join(", ");
    const capability = {
      formatter: "formatting",
      linter: "linting",
      lsp: "language support",
    }[suggestion.recipe.kind];
    return {
      id: `suggestion:${suggestion.pluginId}:${suggestion.recipe.kind}:${suggestion.recipe.id}`,
      message: `Use ${suggestion.recipe.name} for ${languages} ${capability}`,
    };
  });
  return [...actions, ...suggestions].sort((left, right) => left.id.localeCompare(right.id));
}

function fingerprint(items: readonly SetupItem[]): string {
  return createHash("sha256")
    .update(items.map((item) => `${item.id}\0${item.message}`).join("\0"))
    .digest("hex")
    .slice(0, 12);
}
