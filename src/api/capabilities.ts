import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const IDE_CAPABILITIES_VERSION = 1 as const;
export const IDE_CAPABILITIES_REGISTER = "pi-agent-ide/capabilities/register/v1";
export const IDE_CAPABILITIES_READY = "pi-agent-ide/capabilities/ready/v1";

/** Additive schema metadata; the owning tool retains validation, execution and permissions. */
export interface IdeCapabilitySchema {
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly promptGuidelines?: readonly string[];
}

export interface IdeCapability {
  readonly version: typeof IDE_CAPABILITIES_VERSION;
  readonly id: string;
  /** Existing tools whose discovery or first execution activates this capability. */
  readonly tools: readonly string[];
  /** Add a native deferred loader for capabilities without their own action tool. */
  readonly discovery?: {
    /** Reserved IDE-owned tool name: ide_capability_<unique_name>. */
    readonly name: string;
    readonly description: string;
    readonly namespace?: { readonly name: string; readonly description: string };
  };
  /** Target IDE tool names. Only activated capabilities contribute this metadata. */
  readonly schemas: Readonly<Record<string, IdeCapabilitySchema>>;
}

export interface IdeCapabilityRegistration {
  readonly capability: IdeCapability;
  accept(error?: Error): void;
}

/** Register once per extension runtime, before or after IDE. Duplicate IDs are errors. */
export function registerIdeCapability(
  pi: Pick<ExtensionAPI, "events" | "on">,
  capability: IdeCapability,
): void {
  const announce = (): boolean => {
    let accepted = false;
    let error: Error | undefined;
    pi.events.emit(IDE_CAPABILITIES_REGISTER, {
      capability,
      accept(failure) {
        if (accepted) throw new Error("Capability registration was accepted twice");
        accepted = true;
        error = failure;
      },
    } satisfies IdeCapabilityRegistration);
    if (error !== undefined) throw error;
    return accepted;
  };
  let unsubscribe = pi.events.on(IDE_CAPABILITIES_READY, () => {
    if (!announce()) throw new Error("IDE capability service did not accept registration");
    unsubscribe();
  });
  pi.on("session_shutdown", unsubscribe);
  if (announce()) unsubscribe();
}
