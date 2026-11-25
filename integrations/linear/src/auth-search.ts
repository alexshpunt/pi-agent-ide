import type { SearchResolver, SearchSelectionProvider } from "pi-agent-ide/api/search";
import {
  createLinearSearchResolver,
  type ObjectSearcher,
  type ResourceTextReader,
} from "./search.ts";
import { currentLinearAuthEpoch, type createLinearAuthBoundary } from "./auth-boundary.ts";
import { linearLocation } from "./environment.ts";

type Boundary = ReturnType<typeof createLinearAuthBoundary>;
/** Run Linear search under the current auth generation and refuse selections refreshed under another one. */
export function createAuthenticatedLinearSearch(
  auth: Boundary,
  searchObjects: ObjectSearcher,
  readText: ResourceTextReader,
  registerSelection?: SearchSelectionProvider,
): SearchResolver {
  const base = createLinearSearchResolver(searchObjects, readText, registerSelection);
  return {
    ...base,
    async tryResolve(request, context) {
      const claimed =
        request.query.startsWith("linear:") ||
        !!linearLocation(request.path) ||
        context.scope?.targets.some((target) => !!linearLocation(target.source));
      if (!claimed) return base.tryResolve(request, context);
      return auth.run(context.cwd, context.signal, async () => {
        const expected = currentLinearAuthEpoch();
        const scoped = createLinearSearchResolver(
          searchObjects,
          readText,
          registerSelection
            ? (selection, scope) =>
                registerSelection(
                  {
                    ...selection,
                    refresh: (signal) =>
                      auth.run(scope.cwd, signal, async () => {
                        if (currentLinearAuthEpoch() !== expected)
                          throw new Error("LINEAR_AUTH_CHANGED");
                        return selection.refresh(signal);
                      }),
                  },
                  scope,
                )
            : undefined,
        );
        return scoped.tryResolve(request, context);
      });
    },
  };
}
