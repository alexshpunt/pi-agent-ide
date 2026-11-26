import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mimic tool_search activating a newly registered deferred tool in a real Pi session.
export default function activateDynamic(pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.toolName === "unity_search" && !event.isError) {
      if (
        !pi
          .getAllTools()
          .some((tool) => tool.name === "unity_scene_get_hierarchy" && tool.exposure === "deferred")
      ) {
        throw new Error("Expected deferred Unity scene tool was not registered");
      }
      pi.setActiveTools([...pi.getActiveTools(), "unity_scene_get_hierarchy"]);
    }
  });
}
