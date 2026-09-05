import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { format } from "oxfmt";

import { FORMATTER_RECIPES } from "#src/plugins/pi-agent-ide-formatter/src/catalog.js";
import { LANGUAGES } from "#src/plugins/pi-agent-ide-languages/src/languages.js";
import { LINTER_RECIPES } from "#src/plugins/pi-agent-ide-lint/src/catalog.js";
import { LSP_RECIPES } from "#src/plugins/pi-agent-ide-lsp/src/catalog.js";

const outputDirectory = path.resolve("docs", "generated", "tool-catalog");
const isCheck = process.argv.includes("--check");
const recipes = [...FORMATTER_RECIPES, ...LINTER_RECIPES, ...LSP_RECIPES];
const expected = new Map<string, string>();

expected.set(
  "index.md",
  [
    "# Tool catalog",
    "",
    "This reference is generated from doctor contributions. Edit the owning plugin catalog, then run `pnpm docs:catalog`.",
    "",
    ...LANGUAGES.map((language) => `- [${language.name}](./${language.id}.md)`),
    "",
  ].join("\n"),
);

for (const language of LANGUAGES) {
  const entries = recipes.filter((recipe) => recipe.languages.includes(language.id));
  expected.set(
    `${language.id}.md`,
    [
      `# ${language.name}`,
      "",
      `Detected extensions: ${
        language.extensions.length > 0
          ? language.extensions.map((item) => `\`${item}\``).join(", ")
          : "file names only"
      }.`,
      "",
      "| Kind | Tool | Detection | Documentation |",
      "| --- | --- | --- | --- |",
      ...entries.map(
        (recipe) =>
          `| ${recipe.kind} | \`${recipe.id}\` | ${
            (recipe.configFiles ?? []).map((item) => `\`${item}\``).join(", ") || "executable"
          } | [Official docs](${recipe.documentation}) |`,
      ),
      "",
    ].join("\n"),
  );
}

await mkdir(outputDirectory, { recursive: true });
let isDrift = false;

for (const [name, content] of expected) {
  const file = path.join(outputDirectory, name);
  const formatted = await format(file, content);
  if (formatted.errors.length > 0) {
    throw new Error(
      `Cannot format generated tool catalog ${file}: ${formatted.errors[0]?.message ?? "unknown error"}`,
    );
  }
  const expectedContent = formatted.code;

  if (isCheck) {
    const current = await readFile(file, "utf8").catch(() => "");

    if (current !== expectedContent) {
      console.error(`Generated tool catalog is stale: ${file}`);
      isDrift = true;
    }
  } else {
    await writeFile(file, expectedContent, "utf8");
  }
}

if (isDrift) {
  process.exitCode = 1;
}
