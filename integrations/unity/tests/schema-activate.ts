import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function activateFixture(pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.toolName === "unity_search" && !event.isError) {
      if (!pi.getAllTools().some((tool) => tool.name === "unity_fixture_inspect"))
        throw Error("Fixture tool was not registered");
      pi.setActiveTools([...pi.getActiveTools(), "unity_fixture_inspect"]);
    }
  });
}
