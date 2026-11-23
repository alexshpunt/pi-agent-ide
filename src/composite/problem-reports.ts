import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ExtensionUIContext,
  ExtensionWidgetOptions,
  Theme,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  crashError,
  guardComponent,
  guardRenderer,
  installRejectionGuard,
  isProgrammingError,
  ProblemReporter,
  stackMentions,
  takeUnreportedCrashes,
  type Problem,
  type ProblemAction,
  type ProblemSource,
} from "pi-problem-report";

export const PROBLEM_REPORTS_FLAG = "pi-agent-ide-problem-reports";
const PROBLEM_COMMAND = "agent-ide-problem";
const PACKAGE_NAME = "pi-agent-ide";

function readManifest(directory: string): { name?: unknown; version?: unknown } | undefined {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    return typeof manifest === "object" && manifest !== null ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed Pi Agent IDE package: the nearest folder above this module whose manifest names
 * it. Sources run from `src/` in a checkout and from bundled chunks in `dist/` when published.
 */
function findPackage(): { root: string; version: string } | undefined {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = readManifest(directory);
    if (manifest?.name === PACKAGE_NAME)
      return {
        root: directory,
        version: typeof manifest.version === "string" ? manifest.version : "unknown",
      };
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const PACKAGE = findPackage();
/** Stack frames under these folders belong to Pi Agent IDE; none when the package is not found. */
const PACKAGE_ROOTS = PACKAGE === undefined ? [] : [PACKAGE.root];

export const IDE_PROBLEM_SOURCE: ProblemSource = {
  name: PACKAGE_NAME,
  version: PACKAGE?.version ?? "unknown",
  issuesUrl: "https://github.com/alexshpunt/pi-agent-ide/issues",
};

/** Who registered a hook: a built-in module, or the composite itself. */
export interface GuardOwner {
  readonly id: string;
  /** A module that failed to register: its hooks do nothing and its tools refuse to run. */
  readonly disabled?: () => boolean;
}

export interface IdeProblemReports {
  readonly reporter: ProblemReporter;
  /** Report a problem unless the same error object was already reported. */
  report(problem: Problem): void;
  /** Wrap an API so its hooks report internal errors and its components never break a frame. */
  guard<TApi extends ExtensionAPI>(api: TApi, owner: GuardOwner): TApi;
}

/**
 * Offer a prefilled GitHub issue for internal Pi Agent IDE errors. Nothing is sent: the panel
 * opens the issue form, copies the report or closes.
 */
export function createIdeProblemReports(
  pi: Pick<ExtensionAPI, "on" | "registerCommand">,
  options: { readonly enabled: () => boolean; readonly disable: () => Promise<void> },
): IdeProblemReports {
  const reporter = new ProblemReporter(IDE_PROBLEM_SOURCE, {
    enabled: options.enabled,
    disable: options.disable,
    command: PROBLEM_COMMAND,
    disabledNotice:
      "Pi Agent IDE problem reports are off. Turn them back on with Problem reports in /agent-ide-settings.",
  });
  const reported = new WeakSet<object>();
  const report = (problem: Problem): void => {
    const error = problem.error;
    if (typeof error === "object" && error !== null) {
      // A hook error passes through several guards on its way up; report it once.
      if (reported.has(error)) return;
      reported.add(error);
    }
    reporter.show(problem);
  };

  pi.on("session_start", (_event, context) => {
    if (!context.hasUI) return;
    reporter.attach(context.ui);
    // Without a UI, the default crash keeps the failure visible; here the panel reports it.
    installRejectionGuard({
      id: IDE_PROBLEM_SOURCE.name,
      owns: (reason) => stackMentions(reason, PACKAGE_ROOTS),
      report: (reason) =>
        report({
          summary: "background task failed",
          error: reason,
          consequence: "Pi keeps working. Please report this so it can be fixed:",
        }),
    });
    // Reading the log marks its crashes as offered; while panels are off, leave them for later.
    if (!options.enabled()) return;
    for (const crash of takeUnreportedCrashes({
      source: IDE_PROBLEM_SOURCE.name,
      roots: PACKAGE_ROOTS,
    })) {
      reporter.show({
        summary: "crashed Pi",
        error: crashError(crash),
        key: `crash:${crash.timestamp}`,
        consequence: "Pi restarted. Please report this so it can be fixed:",
        context: [
          `Crashed at: ${crash.timestamp}`,
          ...(crash.version === undefined ? [] : [`Pi version at the crash: ${crash.version}`]),
        ],
      });
    }
  });
  pi.on("session_shutdown", () => reporter.detach());
  // Panel buttons take clicks only in fullscreen mode; the command works everywhere.
  const actions = new Map<string, ProblemAction>([
    ["open", "open"],
    ["copy", "copy"],
    ["close", "close"],
    ["off", "disable"],
  ]);
  pi.registerCommand(PROBLEM_COMMAND, {
    description: "Open, copy or dismiss the shown Pi Agent IDE problem report",
    getArgumentCompletions: (prefix) =>
      [...actions.keys()]
        .filter((name) => name.startsWith(prefix.trim()))
        .map((name) => ({ value: name, label: name })),
    handler: async (args, context) => {
      const action = actions.get(args.trim() || "open");
      if (action === undefined) {
        context.ui.notify(`Use /${PROBLEM_COMMAND} ${[...actions.keys()].join("|")}.`, "error");
        return;
      }
      if (!reporter.act(action))
        context.ui.notify("No Pi Agent IDE problem report is shown.", "info");
    },
  });

  return { reporter, report, guard: (api, owner) => guardExtensionApi(api, owner, report) };
}

/** Read a member of a Pi object wrapped by a proxy that changes only a few of its members. */
function forward(
  target: ExtensionContext | ExtensionUIContext,
  property: string | symbol,
): unknown {
  // oxlint-disable-next-line anti-slop/no-reflect-get -- a transparent proxy forwards every other member as is
  return Reflect.get(target, property);
}

/** Report a rejection of a returned promise without handling it for the caller. */
function observe<R>(result: R, onError: (error: unknown) => void): R {
  if (result instanceof Promise) result.catch(onError);
  return result;
}

/**
 * Wrap the registration surface of an extension API. Hooks and tools keep their results and
 * errors; programming errors are also reported. Expected failures, such as a missing file, stay
 * ordinary errors. Components that throw while drawing are reported and replaced by a notice,
 * because Pi ends the process on an exception during a frame.
 */
export function guardExtensionApi<TApi extends ExtensionAPI>(
  api: TApi,
  owner: GuardOwner,
  report: (problem: Problem) => void,
): TApi {
  const disabled = owner.disabled ?? (() => false);
  const moduleContext = owner.id === "core" ? [] : [`Module: ${owner.id}`];
  const drawFailure =
    (what: string) =>
    (error: unknown): void =>
      report({
        summary: `could not draw ${what}`,
        error,
        context: moduleContext,
        consequence: "Pi keeps working and shows a notice instead. Please report this:",
      });
  const hookFailure =
    (hook: string) =>
    (error: unknown): void => {
      if (isProgrammingError(error))
        report({
          summary: `failed while handling ${hook}`,
          error,
          context: [...moduleContext, `Hook: ${hook}`],
        });
    };

  const guardUi = (ui: ExtensionUIContext): ExtensionUIContext => {
    const setWidget = (key: string, content: unknown, options?: ExtensionWidgetOptions): void => {
      const guarded =
        typeof content === "function"
          ? guardRenderer(
              content as (tui: TUI, theme: Theme) => Component,
              drawFailure(`the ${key} panel`),
            )
          : content;
      // The overloads pair a line list or a component factory with the same options.
      ui.setWidget(key, guarded as string[] | undefined, options);
    };
    const custom: ExtensionUIContext["custom"] = (factory, options) =>
      ui.custom((...args) => {
        const component = factory(...args);
        const fail = drawFailure("a dialog");
        return component instanceof Promise
          ? component.then((item) => guardComponent(item, fail))
          : guardComponent(component, fail);
      }, options);
    return new Proxy(ui, {
      get: (target, property) =>
        property === "setWidget"
          ? setWidget
          : property === "custom"
            ? custom
            : forward(target, property),
    });
  };
  const guardContext = <TContext extends ExtensionContext>(context: TContext): TContext => {
    let ui: ExtensionUIContext | undefined;
    return new Proxy(context, {
      get: (target, property) => {
        if (property !== "ui") return forward(target, property);
        ui ??= guardUi(target.ui);
        return ui;
      },
    });
  };

  const guardHook =
    <A, C extends ExtensionContext, R>(hook: string, handler: (arg: A, context: C) => R) =>
    (arg: A, context: C): R | undefined => {
      if (disabled()) return undefined;
      try {
        return observe(handler(arg, guardContext(context)), hookFailure(hook));
      } catch (error) {
        hookFailure(hook)(error);
        throw error;
      }
    };

  // The SDK overloads describe event/handler pairs; forwarding keeps the original pair.
  const on: ExtensionAPI["on"] = (event, handler) =>
    api.on(
      event as "tool_call",
      guardHook(event, handler as ExtensionHandler<ToolCallEvent, ToolCallEventResult>),
    );

  const registerTool: ExtensionAPI["registerTool"] = (definition) => {
    const name = definition.name;
    const execute: typeof definition.execute = async (id, params, signal, onUpdate, context) => {
      if (disabled())
        throw new Error(
          `The Pi Agent IDE ${owner.id} module failed to load, so ${name} is unavailable until Pi reloads.`,
        );
      try {
        return await definition.execute(id, params, signal, onUpdate, guardContext(context));
      } catch (error) {
        if (isProgrammingError(error))
          report({
            summary: `${name} tool failed with an internal error`,
            error,
            context: [...moduleContext, `Tool: ${name}`],
            consequence: "The agent got the error as the tool result. Please report this:",
          });
        throw error;
      }
    };
    const renderCall =
      definition.renderCall && guardRenderer(definition.renderCall, drawFailure(`a ${name} call`));
    const renderResult =
      definition.renderResult &&
      guardRenderer(definition.renderResult, drawFailure(`a ${name} result`));
    // Getters keep lazily built prompt fields live for the wrappers that follow.
    api.registerTool({
      ...definition,
      get description() {
        return definition.description;
      },
      get promptGuidelines() {
        return definition.promptGuidelines;
      },
      get parameters() {
        return definition.parameters;
      },
      execute,
      ...(renderCall && { renderCall }),
      ...(renderResult && { renderResult }),
    });
  };

  const registerCommand: ExtensionAPI["registerCommand"] = (name, command) =>
    api.registerCommand(name, {
      ...command,
      handler: async (args, context) => {
        if (disabled()) {
          context.ui.notify(
            `The Pi Agent IDE ${owner.id} module failed to load; /${name} is unavailable until Pi reloads.`,
            "error",
          );
          return;
        }
        await guardHook(`/${name}`, command.handler)(args, context);
      },
    });

  const registerShortcut: ExtensionAPI["registerShortcut"] = (shortcut, options) =>
    api.registerShortcut(shortcut, {
      ...options,
      handler: async (context) => {
        await guardHook(`the ${shortcut} shortcut`, (_: undefined, guarded: typeof context) =>
          options.handler(guarded),
        )(undefined, context);
      },
    });

  const registerMessageRenderer: ExtensionAPI["registerMessageRenderer"] = (type, renderer) =>
    api.registerMessageRenderer(type, guardRenderer(renderer, drawFailure(`a ${type} message`)));

  const registerEntryRenderer: ExtensionAPI["registerEntryRenderer"] = (type, renderer) =>
    api.registerEntryRenderer(type, guardRenderer(renderer, drawFailure(`a ${type} entry`)));

  const registerToolRenderer: ExtensionAPI["registerToolRenderer"] = (resolver) =>
    api.registerToolRenderer((name, next) => {
      const renderers = resolver(name, next);
      if (renderers === undefined) return renderers;
      const { renderCall, renderResult } = renderers;
      return {
        ...renderers,
        ...(renderCall && { renderCall: guardRenderer(renderCall, drawFailure(`a ${name} call`)) }),
        ...(renderResult && {
          renderResult: guardRenderer(renderResult, drawFailure(`a ${name} result`)),
        }),
      };
    });

  const events: ExtensionAPI["events"] = {
    emit: (channel, data) => api.events.emit(channel, data),
    on: (channel, handler) =>
      api.events.on(channel, (data) => {
        if (disabled()) return;
        try {
          return observe(handler(data), hookFailure(channel));
        } catch (error) {
          hookFailure(channel)(error);
          throw error;
        }
      }),
  };

  return {
    ...api,
    on,
    events,
    registerTool,
    registerCommand,
    registerShortcut,
    registerMessageRenderer,
    registerEntryRenderer,
    registerToolRenderer,
  };
}
