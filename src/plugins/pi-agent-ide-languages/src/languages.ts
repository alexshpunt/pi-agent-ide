import type { LanguageDefinition } from "pi-agent-doctor/api/catalog";

/**
Language definitions owned by the language-detection plugin.
*/
export const LANGUAGES: readonly LanguageDefinition[] = [
  language(
    "c",
    "C",
    [".c", ".h"],
    ["CMakeLists.txt", "meson.build", "compile_commands.json"],
    "tree-sitter",
  ),
  language(
    "cpp",
    "C++",
    [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    ["CMakeLists.txt", "meson.build", "compile_commands.json", "conanfile.py", "vcpkg.json"],
    "tree-sitter",
  ),
  language("csharp", "C#", [".cs"], [".sln", ".csproj", "global.json"]),
  language("go", "Go", [".go"], ["go.mod", "go.work"]),
  language("java", "Java", [".java"], ["pom.xml", "build.gradle", "build.gradle.kts"]),
  language("kotlin", "Kotlin", [".kt", ".kts"], ["build.gradle.kts", "settings.gradle.kts"]),
  language(
    "javascript",
    "JavaScript",
    [".js", ".jsx", ".mjs", ".cjs"],
    ["package.json"],
    "tree-sitter",
  ),
  language(
    "typescript",
    "TypeScript",
    [".ts", ".tsx", ".mts", ".cts"],
    ["tsconfig.json", "package.json"],
    "tree-sitter",
  ),
  language(
    "python",
    "Python",
    [".py", ".pyi"],
    ["pyproject.toml", "requirements.txt", "setup.py"],
    "tree-sitter",
  ),
  language("rust", "Rust", [".rs"], ["Cargo.toml"], "tree-sitter"),
  language("ruby", "Ruby", [".rb", ".rake"], ["Gemfile", ".ruby-version"]),
  language("php", "PHP", [".php"], ["composer.json"]),
  language("swift", "Swift", [".swift"], ["Package.swift"]),
  language("lua", "Lua", [".lua"], [".luarc.json", "stylua.toml"]),
  language("shell", "Shell", [".sh", ".bash", ".zsh"], [".shellcheckrc"]),
  language("html", "HTML", [".html", ".htm"], []),
  language("css", "CSS", [".css", ".scss", ".sass", ".less"], ["stylelint.config.js"]),
  language("json", "JSON", [".json", ".jsonc"], [], "tree-sitter"),
  language("yaml", "YAML", [".yaml", ".yml"], [".yamllint"], "tree-sitter"),
  language("toml", "TOML", [".toml"], ["taplo.toml"], "tree-sitter"),
  language("xml", "XML", [".xml", ".xsd", ".xsl"], []),
  language("markdown", "Markdown", [".md", ".mdx"], [".markdownlint.json"]),
  language("sql", "SQL", [".sql"], [".sqlfluff"]),
  language("dockerfile", "Dockerfile", [], ["Dockerfile", "compose.yaml"], undefined, [
    "Dockerfile",
    "Containerfile",
  ]),
  language("terraform", "Terraform", [".tf", ".tfvars"], [".terraform.lock.hcl"]),
  language("cmake", "CMake", [".cmake"], ["CMakeLists.txt"], undefined, ["CMakeLists.txt"]),
];

function language(
  id: string,
  name: string,
  extensions: readonly string[],
  projectMarkers: readonly string[],
  ast?: "tree-sitter",
  fileNames?: readonly string[],
): LanguageDefinition {
  return {
    id,
    name,
    extensions,
    projectMarkers,
    ...(ast && { ast }),
    ...(fileNames && { fileNames }),
  };
}
