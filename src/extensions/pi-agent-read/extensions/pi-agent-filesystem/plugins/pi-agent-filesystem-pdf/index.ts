import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPdfContentConverter } from "pi-agent-pdf";
import { connectContentConverter, type ContentConverterRegistration } from "pi-agent-resource";

const registration = {
    target: { provider: "filesystem", capability: "read" },
    converter: createPdfContentConverter(),
    priority: 200,
} satisfies ContentConverterRegistration;

export default async function registerFilesystemPdf(pi: ExtensionAPI): Promise<void>
{
    await connectContentConverter(pi, registration);
}
