import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hide collapsed Codemode bodies while keeping its native summaries and expanded view. */
export function registerCodemodeRendering(
  pi: Pick<ExtensionAPI, "registerToolRenderer">,
  compact: boolean,
): void {
  pi.registerToolRenderer((name, next) => {
    const original = next();
    if (name !== "codemode" || !compact || !original?.renderCall || !original.renderResult)
      return original;
    const { renderCall, renderResult } = original;
    return {
      ...original,
      renderCall(args, theme, context) {
        return renderCall(
          context.expanded || typeof args !== "object" || args === null
            ? args
            : { ...args, code: "" },
          theme,
          context,
        );
      },
      renderResult(result, options, theme, context) {
        // Change only the display input. Native call rows, errors and retained results stay intact.
        return renderResult(
          options.expanded || context.isError ? result : { ...result, content: [] },
          options,
          theme,
          context,
        );
      },
    };
  });
}
