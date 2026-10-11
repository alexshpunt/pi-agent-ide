/**
 * Shared binary converters for plugins and isolated workers.
 * Factories use the IDE's PDF.js and image runtime; conversion preserves the input bytes.
 */
export { createPdfContentConverter } from "pi-agent-pdf";
export { createImageContentConverter } from "pi-agent-image";
