import { TextAnchor, type TextAnchorResolver, type TextAnchorResolverContext } from "pi-agent-text";

import { ChangeService } from "#src/changes/change-service.js";

import type { ChangeGroup, ChangeInspection } from "#src/changes/change-types.js";
import type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";

export const CHANGE_ANCHOR_KIND = "pi-agent-ide-changes/change";

const changeAnchorPattern = /^CHANGE#[0-9A-F]{4,64}$/;
const resourceSchemePattern = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;

export class ChangeTextAnchor extends TextAnchor {
  public constructor(group: ChangeGroup) {
    super(group.selector, group.currentStartLine);
  }
}

export interface ChangeAnchorRegistration {
  readonly resolver: TextAnchorResolver;
}

export function createChangeAnchorRegistration(
  executor: GitCommandExecutor,
): ChangeAnchorRegistration {
  const inspect = async (
    context: TextAnchorResolverContext,
  ): Promise<ChangeInspection | undefined> => {
    if (resourceSchemePattern.test(context.source)) {
      return undefined;
    }

    const creation = await ChangeService.create(executor, context.cwd, context.signal);

    if (creation.status !== "ready") {
      throw new Error(creation.message);
    }

    return creation.service.inspect({
      source: context.source,
      worktreeText: context.content,
      cwd: context.cwd,
      ...(context.signal !== undefined && { signal: context.signal }),
    });
  };

  return {
    resolver: createChangeAnchorResolver(inspect),
  };
}

function createChangeAnchorResolver(
  inspect: (context: TextAnchorResolverContext) => Promise<ChangeInspection | undefined>,
): TextAnchorResolver {
  return {
    id: "git-change",
    description: "Use the complete `CHANGE#HASH` shown beside a current Git change.",
    renderFull(value) {
      return value;
    },
    renderCompact(value) {
      return value;
    },
    async tryResolve(value, context) {
      if (!changeAnchorPattern.test(value)) {
        return { kind: "not-handled" };
      }

      try {
        const inspection = await inspect(context);

        if (inspection === undefined) {
          return { kind: "not-handled" };
        }

        if (inspection.status === "unavailable") {
          return { kind: "failed", error: new Error(inspection.message) };
        }

        const group =
          inspection.status === "applicable"
            ? inspection.groups.find((candidate) => candidate.selector === value)
            : undefined;

        return group === undefined
          ? {
              kind: "rejected",
              rejection: {
                code: "stale",
                reason: `Change anchor ${value} is stale or unknown`,
              },
            }
          : { kind: "resolved", anchor: new ChangeTextAnchor(group) };
      } catch (error) {
        return { kind: "failed", error };
      }
    },
  };
}
