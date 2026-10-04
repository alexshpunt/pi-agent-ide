import path from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

/** Check normal configured loading without sending a prompt or spending provider tokens. */
const { session, extensionsResult } = await createAgentSession({
  cwd: process.cwd(),
  sessionManager: SessionManager.inMemory(),
});
try {
  const errors: unknown[] = [...extensionsResult.errors];
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  const ideEntries = extensionsResult.extensions.filter((extension) =>
    /^pi-agent-ide\.[jt]s$/u.test(path.basename(extension.path)),
  );
  const expected = process.argv[2];
  if (
    ideEntries.length !== 1 ||
    (expected !== undefined && ideEntries[0]?.path !== path.resolve(expected))
  ) {
    throw new Error(
      "Expected exactly one configured IDE entry: " +
        JSON.stringify(ideEntries.map((entry) => entry.path)),
    );
  }
  if (errors.length > 0) throw new Error("Configured startup errors: " + JSON.stringify(errors));
  if (session.getToolDefinition("search") === undefined)
    throw new Error("Search failed to register.");
  console.log(
    JSON.stringify(
      {
        status: "passed",
        ideEntries: ideEntries.map((entry) => entry.path),
        startupErrors: errors,
        warnings: extensionsResult.warnings ?? [],
        sessionMessages: session.messages.length,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}
