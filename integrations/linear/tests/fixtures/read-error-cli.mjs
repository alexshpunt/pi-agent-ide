import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { axiSource, identifier, logFile } = JSON.parse(await readFile("axi-proof.json", "utf8"));
const require = createRequire(path.join(axiSource, "package.json"));
const { resourceOperationCommand } = await import(pathToFileURL(path.join(axiSource, "src/commands/resource-operations.ts")).href);
const sdkRoot = path.resolve(path.dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js")), "../../..");
// The adapter is ESM too; require.resolve of the public entry would select a separate CJS class.
const { StreamableHTTPError } = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/client/streamableHttp.js")).href);
const { UnauthorizedError } = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/client/auth.js")).href);
const privateText = "fixture-private-secret bearer and response body";
const log = async operation => appendFile(logFile, JSON.stringify({ identifier, operation }) + "\n");
const runtime = {
  cwd: process.cwd(), env: {}, stdout: process.stdout, mcpUrl: "https://example.invalid/mcp",
  client: {
    async listTools() {
      await log("listTools");
      if (identifier === "ENG-852") throw new Error(privateText);
      if (identifier === "ENG-860") throw new StreamableHTTPError(429, privateText);
      return [{ name: "get_issue", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }];
    },
    async callTool(operation) {
      await log(operation);
      if (operation === "get_workspace") {
        if (identifier === "ENG-853") throw new UnauthorizedError(privateText);
        if (identifier === "ENG-857") throw new Error(privateText, { cause: Object.assign(new Error(privateText), { code: "ECONNRESET" }) });
        return { structuredContent: { url: "https://linear.app/example" } };
      }
      if (identifier === "ENG-851") throw new StreamableHTTPError(429, privateText);
      if (identifier === "ENG-855") return { isError: true, content: [{ type: "text", text: privateText }] };
      if (identifier === "ENG-856") throw Object.assign(new Error(privateText), { code: "ETIMEDOUT" });
      if (identifier === "ENG-859") throw new Error(privateText);
      return { structuredContent: { id: identifier, identifier, uuid: "36b6a1d9-793d-4937-bf41-bbe4791a980d", title: "Readable issue", ...(identifier === "ENG-854" ? {} : { estimate: null }) } };
    },
  },
  searchClient: {
    async readIssueEstimate() { await log("readIssueEstimate"); throw new Error("LINEAR_PERMISSION_DENIED"); },
  },
};
try {
  process.stdout.write(await resourceOperationCommand(process.argv.slice(3), runtime));
} catch (error) {
  const code = error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
    ? error.message : "LINEAR_OPERATION_UNKNOWN";
  process.stdout.write(`error: ${code}\n`);
  process.exitCode = 1;
}
