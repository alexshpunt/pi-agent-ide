import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectContentConverter, type ContentConverterRegistration } from "pi-agent-resource";

import { createHtmlContentConverter } from "./src/html-converter.js";

const registration = {
    target: { provider: "web", capability: "read" },
    converter: createHtmlContentConverter(),
    priority: 200,
} satisfies ContentConverterRegistration;

export default async function registerWebHtml(pi: ExtensionAPI): Promise<void>
{
    await connectContentConverter(pi, registration);
}
