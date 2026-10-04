/** Shared editing workflows owned by enabled mutation tools. */
export const EDITING_GUIDELINES = [
  "Use the smallest useful source view: reuse sufficient content and anchors, search for known text, or inspect structure when locating a declaration. Read nearby context when boundaries are unclear; resolve ambiguity rather than guessing.",
  "Use an available anchor when it selects exactly the intended text; otherwise use minimal unique exact text. Keep the edit limited to the intended content.",
  "When search broadens to separate words, treat its results as location hints. Refine the query before using those matches for replacement.",
  "Use standalone mutation tools in one assistant-response batch when each change is known in advance and does not depend on another change. This is the default for several independent edits in one file or across files. Every call is evaluated against the original file snapshots. Combine overlapping changes into one mutation. Use native Codemode for computed or dependent tool composition; it keeps the same tool contracts and does not add grouped rollback. Check each batch result and retry only unapplied changes.",
  "Inside native Codemode, submit independent local text-edit calls on disjoint resource sets concurrently; await calls on overlapping sets in order. Check each result's status. Await tools.flush({}) when later script work needs a committed receipt. Check the parent result for automatic batch commits before retrying an accepted call. Read docs:editing for batch boundaries and dependent work.",
] as const;
