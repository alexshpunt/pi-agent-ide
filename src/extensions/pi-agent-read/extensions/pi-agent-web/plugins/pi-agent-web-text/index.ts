import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectContentConverter, type ContentConverterRegistration } from "pi-agent-resource";
import { createTextContentConverter } from "pi-agent-text";

const registration = {
    target: { provider: "web", capability: "read" },
    converter: createTextContentConverter(),
    priority: 300,
} satisfies ContentConverterRegistration;

export default async function registerWebText(pi: ExtensionAPI): Promise<void>
{
    await connectContentConverter(pi, registration);
}
