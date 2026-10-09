/** Synthetic application files shared by the real-Pi hook test and current-runtime proof. */
export const SSH_HOOK_TEXT_FILES = [
  ["secret.json", '{"message":"PRIVATE_OWNED_READ_CONTENT"}\n'],
  ["secret.ts", 'export const label = "PRIVATE_OWNED_READ_CONTENT";\n'],
  ["throw.txt", "PRIVATE_OWNED_READ_CONTENT\n"],
  ["locked.txt", "remote café destination\n"],
] as const;

/** Native stdout formatter makes the final saved revision visible to after-edit hooks. */
export const SSH_HOOK_FORMATTERS = {
  version: 1,
  formatters: {
    owned: {
      extensions: [".fixture"],
      run: { command: ["python3", "-c", "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text().upper(),end='')", "{file}"] },
      output: "stdout",
    },
  },
};
