import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageContentConverter } from "pi-agent-image";
import { connectContentConverter, type ContentConverterRegistration } from "pi-agent-resource";

const registration = {
    target: { provider: "filesystem", capability: "read" },
    converter: createImageContentConverter(),
    priority: 100,
} satisfies ContentConverterRegistration;

export default async function registerFilesystemImage(pi: ExtensionAPI): Promise<void>
{
    await connectContentConverter(pi, registration);
}
