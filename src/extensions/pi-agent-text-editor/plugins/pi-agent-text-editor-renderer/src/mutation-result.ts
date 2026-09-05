import { FileMutationResult } from "pi-agent-text-editor/api/mutation-result";

import {
  freezeMutationViewports,
  type FrozenMutationViewports,
  projectFinalResources,
} from "./frozen-viewport.js";

import type { MutationRenderResource } from "./render-resource.js";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

import type { PersistedMutationDetails } from "./persisted-result.js";

interface PersistedTextChange {
  readonly fromA: number;
  readonly toA: number;
  readonly fromB: number;
  readonly toB: number;
  readonly insertedText: string;
}
/** Resolves result resources, optionally deferring model projection until completion. */

export function resolveMutationResultResources(
  details: PersistedMutationDetails | undefined,
  runtimeViewports: FrozenMutationViewports | undefined,
  project = true,
): readonly MutationRenderResource[] {
  const stored = details?.mutationRender;
  if (stored !== undefined) {
    return stored.map(({ path, model }) => ({
      path,
      model,
      ranges: [],
      beforeContent: "",
      afterContent: "",
    }));
  }

  const results = (details?.results ?? []).map((result) => FileMutationResult.ensure(result));
  const finalResources = results.flatMap(finalResource);
  if (!project) {
    return finalResources;
  }

  const viewports = runtimeViewports ?? persistedViewports(results);
  return projectFinalResources(finalResources, viewports);
}

function finalResource(result: FileMutationResult): readonly MutationRenderResource[] {
  const afterContent = result.afterContent;
  const changes = persistedChanges(result.data.rawChanges);

  if (!result.ok || typeof afterContent !== "string") {
    return [];
  }

  return resultPaths(result).flatMap((path) => {
    const before = result.beforeContentMap?.[path];

    if (typeof before !== "string" && before !== null) {
      return [];
    }

    const replayed = changes === undefined ? undefined : replayChanges(before ?? "", changes);
    const typingIdentity =
      replayed === afterContent
        ? {
            beforeRanges: changes?.map(({ fromA: from, toA: to }) => ({ from, to })) ?? [],
            ranges: changes?.map(({ fromB: from, toB: to }) => ({ from, to })) ?? [],
          }
        : undefined;

    return [
      {
        path,
        ranges: [],
        beforeContent: before ?? "",
        ...(typingIdentity === undefined ? {} : { typingIdentity }),
        afterContent,
      },
    ];
  });
}

function persistedViewports(
  results: readonly FileMutationResult[],
): FrozenMutationViewports | undefined {
  const resources = results.flatMap(generatedResource);
  return resources.length === 0 ? undefined : freezeMutationViewports(resources);
}

function generatedResource(result: FileMutationResult): readonly TextMutationPreviewResource[] {
  if (!result.ok) {
    return [];
  }

  const changes = persistedChanges(result.data.rawChanges);

  if (changes === undefined || changes.length === 0) {
    return [];
  }

  return resultPaths(result).flatMap((path) => {
    const before = result.beforeContentMap?.[path];

    if (typeof before !== "string" && before !== null) {
      return [];
    }

    const beforeContent = before ?? "";
    const afterContent = replayChanges(beforeContent, changes);

    if (afterContent === undefined) {
      return [];
    }

    return [
      {
        path,
        beforeContent,
        afterContent,
        beforeRanges: changes.map(({ fromA: from, toA: to }) => ({ from, to })),
        ranges: changes.map(({ fromB: from, toB: to }) => ({ from, to })),
      },
    ];
  });
}

function resultPaths(result: FileMutationResult): readonly string[] {
  return result.files.length > 0
    ? result.files.map(({ path }) => path)
    : result.path === undefined
      ? []
      : [result.path];
}

function persistedChanges(value: unknown): readonly PersistedTextChange[] | undefined {
  if (!Array.isArray(value) || !value.every(isPersistedTextChange)) {
    return undefined;
  }

  return [...value].sort((left, right) => left.fromA - right.fromA);
}

function isPersistedTextChange(value: unknown): value is PersistedTextChange {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const change = value as Partial<PersistedTextChange>;
  return (
    Number.isInteger(change.fromA) &&
    Number.isInteger(change.toA) &&
    Number.isInteger(change.fromB) &&
    Number.isInteger(change.toB) &&
    typeof change.insertedText === "string"
  );
}

function replayChanges(
  before: string,
  changes: readonly PersistedTextChange[],
): string | undefined {
  let content = "";
  let offset = 0;

  for (const change of changes) {
    if (change.fromA < offset || change.toA < change.fromA || change.toA > before.length) {
      return undefined;
    }

    content += before.slice(offset, change.fromA) + change.insertedText;
    offset = change.toA;
  }

  return content + before.slice(offset);
}
