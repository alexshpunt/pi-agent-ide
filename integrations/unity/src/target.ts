import path from "node:path";

export interface EditorInstance {
  projectPath: string;
  pid: number;
  port: number;
  state: string;
  role?: string;
}

function canonicalProject(value: string): string {
  if (path.win32.isAbsolute(value) && (/^[a-z]:/i.test(value) || value.startsWith("\\\\"))) {
    return path.win32
      .normalize(value)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  }
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value).replace(/\/+$/, "") || "/";
  throw new Error("Provide an absolute Unity project path from discovery.");
}

export function selectEditor(project: string, instances: EditorInstance[]): EditorInstance {
  const target = canonicalProject(project);
  const matches = instances.filter(
    (instance) =>
      canonicalProject(instance.projectPath) === target &&
      (!instance.role || instance.role === "main"),
  );
  if (matches.length !== 1)
    throw new Error(`Expected one main editor for ${project}; found ${matches.length}.`);
  const editor = matches[0];
  if (
    editor.state !== "ready" ||
    !Number.isSafeInteger(editor.pid) ||
    editor.pid <= 0 ||
    !Number.isSafeInteger(editor.port) ||
    editor.port <= 0
  ) {
    throw new Error(`The editor for ${project} is not ready.`);
  }
  return editor;
}
