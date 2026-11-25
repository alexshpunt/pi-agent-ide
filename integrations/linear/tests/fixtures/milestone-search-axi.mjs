import { encode } from "@toon-format/toon-v4";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000002";
if (args[0] === "auth" && args[1] === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
} else {
  appendFileSync("axi-calls.jsonl", JSON.stringify(args) + "\n");
  if (args[0] === "resources" && args[1] === "scope" && args[2] === "project") {
    console.log(
      encode({
        project: { id: projectId, url: "https://linear.app/example/project/release-abcdef123456" },
      }),
    );
  } else if (args[0] === "search" && args[1] === "issues") {
    if (
      value("--project-id") !== projectId ||
      !["Release", milestoneId].includes(value("--milestone"))
    )
      throw Error("Missing project or milestone constraint");
    const cursor = args.includes("--cursor") ? value("--cursor") : null;
    const final = cursor === "empty-window";
    const number = cursor ? 13 : 12;
    console.log(
      encode({
        search: {
          kind: "issues",
          workspace: "example",
          term: "release",
          milestoneId,
          items:
            cursor === "first-window"
              ? []
              : [
                  {
                    id: `ENG-${number}`,
                    title: "Release task",
                    url: `https://linear.app/example/issue/ENG-${number}/release`,
                  },
                ],
          hasMore: !final,
          ...(!final ? { cursor: cursor ? "empty-window" : "first-window" } : {}),
          totalCount: 2,
          postFiltered: true,
        },
      }),
    );
  } else throw Error("Unexpected operation");
}
