import path from "node:path";
import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import type { Runtime } from "#axi/types.ts";
import { optionalText } from "./command-input.ts";

/** Bounded private file upload/download with explicit workspace and separate attachment effects. */
export async function assetCommand(args: string[], runtime: Runtime): Promise<string> {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: "assets upload --file report.pdf --workspace example",
  });
  if (parsed.help)
    return "usage: linear-axi assets <upload|download> --workspace <slug> [--file <local-file> --issue ENG-12 --title <title> --content-type <mime>] [--url <private-asset-url> --output <new-local-file>]\ndescription: Upload at most 25 MiB using existing app authorization. Attach only to an explicit issue. Upload/attachment effects are separate; never replay an unknown result. Download refuses non-Linear storage hosts, redirects and output overwrites.\n";
  const [action] = parsed.positionals;
  const { workspace, file, url, output } = parsed;
  const allowed = new Set(
    action === "upload"
      ? ["positionals", "workspace", "file", "issue", "title", "content-type"]
      : ["positionals", "workspace", "url", "output"],
  );
  if (!runtime.storageClient) throw new Error("LINEAR_STORAGE_UNAVAILABLE");
  if (
    (action !== "upload" && action !== "download") ||
    parsed.positionals.length !== 1 ||
    !Object.keys(parsed).every((key) => allowed.has(key)) ||
    typeof workspace !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(workspace)
  )
    throw usage("invalid asset operation");
  if (action === "upload") {
    if (typeof file !== "string" || !file || file.includes("://"))
      throw usage("upload requires a local --file path");
    const upload = await runtime.storageClient.upload({
      cwd: runtime.cwd,
      workspace,
      file,
      issue: optionalText(parsed.issue),
      title: optionalText(parsed.title),
      contentType: optionalText(parsed["content-type"]),
    });
    return renderToon({ upload });
  }
  if (
    typeof url !== "string" ||
    !url ||
    typeof output !== "string" ||
    !output ||
    output.includes("://")
  )
    throw usage("download requires --url and a new local --output path");
  const download = await runtime.storageClient.download({
    workspace,
    url,
    output: path.resolve(runtime.cwd, output),
  });
  return renderToon({ download: { workspace, url, ...download } });
}
