import { convertToPng, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";

import type { AgentContent, ContentConverter } from "pi-agent-resource";

export type SupportedImageMimeType = "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";

type ImageInspection =
    | { readonly kind: "not-handled"; }
    | { readonly kind: "supported"; readonly mimeType: SupportedImageMimeType; }
    | { readonly kind: "invalid"; readonly message: string; };

const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] as const;

export function createImageContentConverter(): ContentConverter
{
    return {
        id: "image",
        description: "JPEG, static PNG, GIF, WebP, and BMP images.",
        async tryConvert(input, context)
        {
            const initialCancellation = cancellationError(context.signal);

            if (initialCancellation !== undefined)
            {
                return { kind: "failed", error: initialCancellation };
            }

            const inspection = inspectImage(input.bytes);

            if (inspection.kind === "not-handled")
            {
                return inspection;
            }

            if (inspection.kind === "invalid")
            {
                return {
                    kind: "failed",
                    error: new TypeError(`${input.source}: ${inspection.message}`),
                };
            }

            try
            {
                const content = await createImageContent(input.bytes, inspection.mimeType);
                const finalCancellation = cancellationError(context.signal);

                if (finalCancellation !== undefined)
                {
                    return { kind: "failed", error: finalCancellation };
                }

                return { kind: "converted", content };
            }
            catch (error)
            {
                const cancellation = cancellationError(context.signal);
                return {
                    kind: "failed",
                    error: cancellation ?? new TypeError(`Unable to process image ${input.source}`, { cause: error }),
                };
            }
        },
    };
}

export function detectSupportedImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null
{
    const inspection = inspectImage(bytes);
    return inspection.kind === "supported" ? inspection.mimeType : null;
}

export async function createImageContent(
    bytes: Uint8Array,
    mimeType: SupportedImageMimeType,
): Promise<AgentContent>
{
    let normalizedBytes = bytes;
    let normalizedMimeType: string = mimeType;
    let convertedFrom: SupportedImageMimeType | undefined;

    if (mimeType === "image/bmp")
    {
        const converted = await convertToPng(Buffer.from(bytes).toString("base64"), mimeType);

        if (converted === null)
        {
            throw new TypeError("Unable to convert image/bmp to an inline image format");
        }

        normalizedBytes = Buffer.from(converted.data, "base64");
        normalizedMimeType = converted.mimeType;
        convertedFrom = mimeType;
    }

    const resized = await resizeImage(normalizedBytes, normalizedMimeType);

    if (resized === null)
    {
        throw new TypeError(`Unable to normalize ${mimeType} within Pi inline image limits`);
    }

    const hints: string[] = [];

    if (convertedFrom !== undefined && convertedFrom !== resized.mimeType)
    {
        hints.push(`[Image converted from ${convertedFrom} to ${resized.mimeType}.]`);
    }

    const dimensionNote = formatDimensionNote(resized);

    if (dimensionNote !== undefined)
    {
        hints.push(dimensionNote);
    }

    const text = [`Read image [${resized.mimeType}]`, ...hints].join("\n");
    return [
        { type: "text", text },
        { type: "image", data: resized.data, mimeType: resized.mimeType },
    ];
}

function inspectImage(bytes: Uint8Array): ImageInspection
{
    if (startsWith(bytes, [0xFF, 0xD8, 0xFF]))
    {
        return bytes[3] === 0xF7
            ? { kind: "not-handled" }
            : { kind: "supported", mimeType: "image/jpeg" };
    }

    if (startsWith(bytes, pngSignature))
    {
        if (!isPng(bytes))
        {
            return { kind: "invalid", message: "Malformed PNG image" };
        }

        if (isAnimatedPng(bytes))
        {
            return { kind: "invalid", message: "Animated PNG is not supported" };
        }

        return { kind: "supported", mimeType: "image/png" };
    }

    if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a"))
    {
        return { kind: "supported", mimeType: "image/gif" };
    }

    if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP"))
    {
        return { kind: "supported", mimeType: "image/webp" };
    }

    if (startsWithAscii(bytes, 0, "BM"))
    {
        return isBmp(bytes)
            ? { kind: "supported", mimeType: "image/bmp" }
            : { kind: "invalid", message: "Malformed BMP image" };
    }

    return { kind: "not-handled" };
}

function isPng(bytes: Uint8Array): boolean
{
    return bytes.length >= 33
        && readUint32BE(bytes, pngSignature.length) === 13
        && startsWithAscii(bytes, 12, "IHDR");
}

function isAnimatedPng(bytes: Uint8Array): boolean
{
    let offset: number = pngSignature.length;

    while (offset + 8 <= bytes.length)
    {
        const chunkLength = readUint32BE(bytes, offset);
        const chunkTypeOffset = offset + 4;

        if (startsWithAscii(bytes, chunkTypeOffset, "acTL"))
        {
            return true;
        }

        if (startsWithAscii(bytes, chunkTypeOffset, "IDAT"))
        {
            return false;
        }

        const nextOffset = offset + 8 + chunkLength + 4;

        if (nextOffset <= offset || nextOffset > bytes.length)
        {
            return false;
        }

        offset = nextOffset;
    }

    return false;
}

function isBmp(bytes: Uint8Array): boolean
{
    if (bytes.length < 26)
    {
        return false;
    }

    const declaredFileSize = readUint32LE(bytes, 2);
    const pixelDataOffset = readUint32LE(bytes, 10);
    const dibHeaderSize = readUint32LE(bytes, 14);

    if (declaredFileSize !== 0 && (declaredFileSize < 26 || declaredFileSize > bytes.length))
    {
        return false;
    }

    if (pixelDataOffset < 14 + dibHeaderSize || pixelDataOffset >= bytes.length)
    {
        return false;
    }

    if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize)
    {
        return false;
    }

    let colorPlanes: number;
    let bitsPerPixel: number;

    if (dibHeaderSize === 12)
    {
        colorPlanes = readUint16LE(bytes, 22);
        bitsPerPixel = readUint16LE(bytes, 24);
    }
    else if (dibHeaderSize >= 40 && dibHeaderSize <= 124)
    {
        if (bytes.length < 30)
        {
            return false;
        }

        colorPlanes = readUint16LE(bytes, 26);
        bitsPerPixel = readUint16LE(bytes, 28);
    }
    else
    {
        return false;
    }

    return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(bytes: Uint8Array, offset: number): number
{
    return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number): number
{
    return (bytes[offset] ?? 0) * 0x1000000
        + ((bytes[offset + 1] ?? 0) << 16)
        + ((bytes[offset + 2] ?? 0) << 8)
        + (bytes[offset + 3] ?? 0);
}

function readUint32LE(bytes: Uint8Array, offset: number): number
{
    return (bytes[offset] ?? 0)
        + ((bytes[offset + 1] ?? 0) << 8)
        + ((bytes[offset + 2] ?? 0) << 16)
        + (bytes[offset + 3] ?? 0) * 0x1000000;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean
{
    return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean
{
    if (bytes.length < offset + text.length)
    {
        return false;
    }

    for (let index = 0; index < text.length; index += 1)
    {
        if (bytes[offset + index] !== text.codePointAt(index))
        {
            return false;
        }
    }

    return true;
}

function cancellationError(signal: AbortSignal | undefined): Error | undefined
{
    if (signal?.aborted !== true)
    {
        return undefined;
    }

    return signal.reason instanceof Error ? signal.reason : abortError();
}

function abortError(): Error
{
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}
