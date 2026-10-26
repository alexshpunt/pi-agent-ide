/** Split an include or exclude glob list on commas and whitespace outside `{}` alternatives. */
export function splitGlobList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  const globs: string[] = [];
  let depth = 0;
  let current = "";

  for (const character of value) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
    }

    if (depth === 0 && (character === "," || /\s/u.test(character))) {
      if (current.length > 0) {
        globs.push(current);
        current = "";
      }

      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    globs.push(current);
  }

  return globs;
}
