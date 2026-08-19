import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectContentConverter, type ContentConverterRegistration } from "pi-agent-resource";
import { createTextContentConverter } from "pi-agent-text";

const converter = createTextContentConverter();
const readRegistration = {
    target: { provider: "filesystem", capability: "read" },
    converter,
    priority: 300,
} satisfies ContentConverterRegistration;
const writeRegistration = {
    target: { provider: "filesystem", capability: "write" },
    converter,
    priority: 300,
} satisfies ContentConverterRegistration;

export default async function registerFilesystemText(pi: ExtensionAPI): Promise<void>
{
    await Promise.all([
        connectContentConverter(pi, readRegistration),
        connectContentConverter(pi, writeRegistration),
    ]);
}
