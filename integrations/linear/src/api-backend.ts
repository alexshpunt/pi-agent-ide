import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceError } from "pi-agent-ide/api/resource";
import type { LinearApiExecutor } from "./api.ts";
import { runAxi } from "./axi.ts";
import { linearErrorRateLimit, linearResourceError } from "./resource-failure.ts";

const maximumBytes = 2 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Private JSON transport to the existing native App gateway. */
export function createLinearApiExecutor(run: typeof runAxi = runAxi): LinearApiExecutor {
  return async (workspace, input, cwd, signal) => {
    if (
      typeof workspace !== "string" ||
      workspace.length > 256 ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(workspace)
    )
      throw new ResourceError("LINEAR_INVALID_WORKSPACE", "linear://", "not-applied");
    const source = `linear://${workspace}/api/graphql`;
    let json: string;
    try {
      json = JSON.stringify(input);
      const value: unknown = JSON.parse(json);
      if (
        !record(value) ||
        Object.keys(value).some((key) => !["query", "variables", "operationName"].includes(key)) ||
        typeof value.query !== "string" ||
        !value.query.trim() ||
        (value.variables !== undefined && !record(value.variables)) ||
        (value.operationName !== undefined &&
          (typeof value.operationName !== "string" ||
            !/^[_A-Za-z][_0-9A-Za-z]*$/u.test(value.operationName)))
      )
        throw new Error("Invalid request");
    } catch {
      throw new ResourceError("LINEAR_GRAPHQL_INPUT_INVALID", source, "not-applied");
    }
    if (Buffer.byteLength(json, "utf8") > maximumBytes)
      throw new ResourceError("LINEAR_CONTENT_TOO_LARGE", source, "not-applied");
    if (signal?.aborted)
      throw new ResourceError("LINEAR_OPERATION_CANCELLED", source, "not-applied");
    let directory: string | undefined;
    let dispatched = false;
    try {
      directory = await mkdtemp(path.join(tmpdir(), "pi-linear-graphql-"));
      await chmod(directory, 0o700);
      const file = path.join(directory, "input.json");
      await writeFile(file, json, { mode: 0o600, flag: "wx" });
      await chmod(file, 0o600);
      if (signal?.aborted)
        throw new ResourceError("LINEAR_OPERATION_CANCELLED", source, "not-applied");
      dispatched = true;
      const output = await run(
        cwd,
        ["api", "graphql", "--workspace", workspace, "--input-file", file],
        signal,
      );
      try {
        if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > maximumBytes)
          throw new Error("Invalid response size");
        const root: unknown = JSON.parse(output);
        if (
          !record(root) ||
          Object.keys(root).length !== 1 ||
          !Object.hasOwn(root, "graphql") ||
          !record(root.graphql) ||
          root.graphql.workspace !== workspace
        )
          throw new Error("Invalid response envelope");
        return root.graphql;
      } catch {
        throw new ResourceError("LINEAR_GRAPHQL_INVALID_RECEIPT", source, "unknown");
      }
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      const code =
        error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "LINEAR_GRAPHQL_GATEWAY_FAILED";
      throw linearResourceError(
        code,
        source,
        dispatched ? "unknown" : "not-applied",
        linearErrorRateLimit(error),
      );
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  };
}
