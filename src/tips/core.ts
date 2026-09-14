import type { Tip, TipContext, TipProvider } from "#src/api/tips.js";

/** A provider-owned tip paired with its source provider ID. */
export interface TipContribution {
  readonly providerId: string;
  readonly tip: Tip;
}

/**
Aggregates independent startup-tip providers and isolates provider failures.
*/
export class TipCore {
  private readonly providers = new Map<string, TipProvider>();

  /** Registers one provider exactly once. */
  public registerProvider(provider: TipProvider): Promise<void> {
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(provider.id)) {
      return Promise.reject(new Error(`Invalid tip provider ID: ${provider.id}`));
    }

    const existing = this.providers.get(provider.id);
    if (existing !== undefined) {
      if (existing === provider) {
        return Promise.resolve();
      }
      return Promise.reject(new Error(`Tip provider ${provider.id} is already registered`));
    }

    this.providers.set(provider.id, provider);
    return Promise.resolve();
  }

  /** Returns whether no providers are registered. */
  public get isEmpty(): boolean {
    return this.providers.size === 0;
  }

  /**
  Runs each provider independently. A failed provider cannot hide other tips.
  */
  public async collectTips(context: TipContext): Promise<readonly TipContribution[]> {
    const contributions: TipContribution[] = [];

    for (const provider of this.providers.values()) {
      if (context.signal?.aborted) break;
      try {
        const tip = await collectTip(provider, context);
        if (tip !== undefined && isTip(tip)) {
          contributions.push({ providerId: provider.id, tip });
        }
      } catch {
        // Providers are optional. One failure must not hide other providers.
      }
    }

    return contributions;
  }
}

async function collectTip(provider: TipProvider, context: TipContext): Promise<Tip | undefined> {
  const signal = context.signal;
  if (signal === undefined) return provider.getTip(context);
  if (signal.aborted) return undefined;
  let abort = (): void => {};
  const cancelled = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    // Release the old session even if an external provider ignores cancellation.
    return await Promise.race([provider.getTip(context), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function isTip(value: Tip): boolean {
  return (
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9.-]*$/u.test(value.id) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.body === "string" &&
    value.body.trim().length > 0
  );
}
