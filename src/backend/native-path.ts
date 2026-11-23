import { fileURLToPath, pathToFileURL } from "node:url";
import { remoteLocation, type SshTargetOs } from "./identity.ts";

/** Translate a canonical owner path into the form accepted by target applications. */
export function sshNativePath(filePath: string, os: SshTargetOs): string {
  if (os !== "windows") return filePath;
  return remoteLocation("target", filePath, os).path.slice(1).replaceAll("/", "\\");
}

/** Construct the target application's file URI without using the controller OS. */
export function sshFileUri(filePath: string, os: SshTargetOs): string {
  return pathToFileURL(sshNativePath(filePath, os), { windows: os === "windows" }).href;
}

/** Map a target application's file URI to a canonical owner location. */
export function remoteLocationFromFileUri(targetId: string, uri: string, os: SshTargetOs) {
  return remoteLocation(targetId, fileURLToPath(uri, { windows: os === "windows" }), os);
}
