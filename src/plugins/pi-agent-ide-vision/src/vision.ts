import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ImageContent } from "pi-agent-resource";

import type { AgentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

let visionDefaults: VisionDefaults = { durationSeconds: 2, intervalSeconds: 0.5, scale: 0.5 };
let allowedExecutables = new Set<string>();

export interface VisionDefaults {
  readonly durationSeconds: number;
  readonly intervalSeconds: number;
  readonly scale: number;
}

export interface VisionRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisionOptions {
  readonly mode: "image" | "sequence";
  readonly durationSeconds?: number;
  readonly intervalSeconds?: number;
  readonly scale?: number;
  readonly region?: VisionRegion;
  /** Square grid cell size in pixels. Omit to return the bounded full image. */
  readonly cellSize?: number;
  /** Zero-based row-major cell index. Requires cellSize and defaults to zero. */
  readonly cellIndex?: number;
}

export interface ProcessMetadata {
  readonly pid: number;
  readonly parentPid?: number;
  readonly command: string;
  readonly started?: string;
  readonly owned: boolean;
  readonly source?: string;
}

export interface CaptureBackend {
  captureWindow(pid: number, signal?: AbortSignal): Promise<Uint8Array>;
  captureDisplay(index: number, signal?: AbortSignal): Promise<Uint8Array>;
  captureUrl(url: URL, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Configures capture defaults and the exact executable allowlist for this runtime. */
export function configureVision(settings: {
  readonly durationSeconds?: string;
  readonly intervalSeconds?: string;
  readonly scale?: string;
  readonly allowedExecutables?: string;
}): void {
  const defaults = validateVisionOptions({
    mode: "sequence",
    durationSeconds: Number(settings.durationSeconds ?? 2),
    intervalSeconds: Number(settings.intervalSeconds ?? 0.5),
    scale: Number(settings.scale ?? 0.5),
  });
  visionDefaults = {
    durationSeconds: defaults.durationSeconds as number,
    intervalSeconds: defaults.intervalSeconds as number,
    scale: defaults.scale as number,
  };
  allowedExecutables = new Set(
    (settings.allowedExecutables ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Returns the configured defaults for capture requests. */
export function getVisionDefaults(): VisionDefaults {
  return visionDefaults;
}

/** Checks an external process against the exact executable-name allowlist. */
export function isExecutableAllowed(command: string): boolean {
  const windowsName = command.includes("\\")
    ? command.slice(command.lastIndexOf("\\") + 1)
    : command;
  const firstArgument = windowsName.trim().split(/\s+/u)[0] ?? "";
  const unixName = firstArgument.slice(firstArgument.lastIndexOf("/") + 1);
  return allowedExecutables.has((command.includes("\\") ? windowsName : unixName).toLowerCase());
}

/** Parses image and sequence view strings with named capture parameters. */
export function parseVisionView(
  views: readonly string[] | undefined,
  defaults: VisionDefaults,
): VisionOptions | undefined {
  const selected = views?.filter((view) => /^(?:image|sequence)(?::|$)/u.test(view)) ?? [];
  if (selected.length === 0) return undefined;
  if (selected.length > 1) throw new Error("Use only one image or sequence view");
  const view = selected[0] as string;
  const separator = view.indexOf(":");
  const mode = view.slice(0, separator < 0 ? undefined : separator) as "image" | "sequence";
  const options: { duration?: number; interval?: number; scale?: number; region?: VisionRegion } =
    {};
  if (separator >= 0) parseViewParameters(view.slice(separator + 1), options);
  if (mode === "image" && (options.duration !== undefined || options.interval !== undefined))
    throw new Error("duration and interval are supported only by the sequence view");
  return validateVisionOptions({
    mode,
    durationSeconds: options.duration ?? defaults.durationSeconds,
    intervalSeconds: options.interval ?? defaults.intervalSeconds,
    scale: options.scale ?? defaults.scale,
    ...(options.region === undefined ? {} : { region: options.region }),
  });
}

function parseViewParameters(
  source: string,
  target: { duration?: number; interval?: number; scale?: number; region?: VisionRegion },
): void {
  if (source.length === 0) throw new Error("View parameters cannot be empty");
  const parts = source.split(",");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    const equals = part.indexOf("=");
    if (equals <= 0) throw new Error(`Invalid view parameter ${part}`);
    const key = part.slice(0, equals);
    const first = part.slice(equals + 1);
    if (key === "region") {
      const values = [first, parts[index + 1], parts[index + 2], parts[index + 3]].map(Number);
      if (values.some((value) => !Number.isFinite(value)))
        throw new Error("region requires x,y,width,height values");
      target.region = {
        x: values[0] as number,
        y: values[1] as number,
        width: values[2] as number,
        height: values[3] as number,
      };
      index += 3;
      continue;
    }
    if (key !== "duration" && key !== "interval" && key !== "scale")
      throw new Error(`Unknown view parameter ${key}`);
    const value = Number(first);
    if (!Number.isFinite(value)) throw new Error(`View parameter ${key} must be a number`);
    if (target[key] !== undefined) throw new Error(`Duplicate view parameter ${key}`);
    target[key] = value;
  }
}

/** Parses display: and display:#N resource identities. */
export function parseDisplaySource(source: string): number | undefined {
  if (!source.startsWith("display:")) return undefined;
  if (source === "display:") return 0;
  const match = /^display:#(\d+)$/u.exec(source);
  if (match === null)
    throw new Error("Display sources use display: or display:#N with a zero-based index");
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index))
    throw new Error("Display sources use display: or display:#N with a zero-based index");
  return index;
}

/** Lists process metadata without granting window access. */
export async function listProcesses(registry: AgentIdeProcessRegistry): Promise<ProcessMetadata[]> {
  const owned = new Map(
    registry
      .list()
      .flatMap((process) => (process.pid === undefined ? [] : [[process.pid, process] as const])),
  );
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return [...owned].map(([pid, item]) => ({
      pid,
      command: item.description,
      owned: true,
      source: item.source,
    }));
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,lstart=,args="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const local = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/u.exec(line);
    if (match === null) return [];
    const pid = Number(match[1]);
    const item = owned.get(pid);
    return [
      {
        pid,
        parentPid: Number(match[2]),
        started: match[3],
        command: match[4] ?? "",
        owned: item !== undefined,
        ...(item === undefined ? {} : { source: item.source }),
      },
    ];
  });
  return isWsl() ? [...local, ...(await listWindowsProcesses())] : local;
}

async function listWindowsProcesses(): Promise<ProcessMetadata[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process | Select-Object Id,ProcessName,Path,StartTime | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    const records: unknown[] = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
    return records.flatMap((record): ProcessMetadata[] => {
      if (
        typeof record !== "object" ||
        record === null ||
        !("Id" in record) ||
        typeof record.Id !== "number"
      )
        return [];
      const name =
        "ProcessName" in record && typeof record.ProcessName === "string"
          ? record.ProcessName
          : "Windows process";
      const path = "Path" in record && typeof record.Path === "string" ? record.Path : undefined;
      const started =
        "StartTime" in record && typeof record.StartTime === "string"
          ? record.StartTime
          : undefined;
      return [
        {
          pid: record.Id,
          command: path ?? name,
          owned: false,
          ...(started === undefined ? {} : { started }),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Reads one PID while preserving registry ownership metadata. */
export async function readProcess(
  pid: number,
  registry: AgentIdeProcessRegistry,
): Promise<ProcessMetadata> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Process PID must be a positive integer");
  const found = (await listProcesses(registry)).find((item) => item.pid === pid);
  if (found === undefined) throw new Error(`Process ${pid} is not running`);
  return found;
}

/** Validates bounded capture selectors before any desktop access occurs. */
export function validateVisionOptions(options: VisionOptions): VisionOptions {
  const scale = options.scale ?? 1;
  if (!(scale > 0 && scale <= 1))
    throw new Error("Image scale must be greater than 0 and at most 1");
  const duration = options.durationSeconds ?? 0;
  const interval = options.intervalSeconds ?? 1;
  if (options.mode === "sequence") {
    if (!(duration > 0 && duration <= 10))
      throw new Error("Sequence duration must be greater than 0 and at most 10 seconds");
    if (!(interval > 0)) throw new Error("Sequence interval must be greater than 0 seconds");
    if (Math.floor(duration / interval) + 1 > 20)
      throw new Error("Sequence capture is limited to 20 frames");
  }
  if (options.region !== undefined) {
    const { x, y, width, height } = options.region;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1)
      throw new Error("Image region x,y,width,height must fit within normalized bounds 0..1");
  }
  if (options.cellIndex !== undefined && options.cellSize === undefined)
    throw new Error("Image offset requires limit to set the square grid cell size");
  if (
    options.cellSize !== undefined &&
    (!Number.isSafeInteger(options.cellSize) || options.cellSize <= 0)
  )
    throw new Error("Image limit must be a positive integer pixel size");
  if (
    options.cellIndex !== undefined &&
    (!Number.isSafeInteger(options.cellIndex) || options.cellIndex < 0)
  )
    throw new Error("Image offset must be a zero-based cell index");
  return options;
}

/** Captures and transforms a bounded image or sequence. */
export async function captureImages(
  capture: () => Promise<Uint8Array>,
  options: VisionOptions,
  signal?: AbortSignal,
): Promise<ImageContent[]> {
  const selected = validateVisionOptions(options);
  const count =
    selected.mode === "image"
      ? 1
      : Math.floor((selected.durationSeconds as number) / (selected.intervalSeconds as number)) + 1;
  const images: ImageContent[] = [];
  let bytes = 0;
  for (let frame = 0; frame < count; frame += 1) {
    signal?.throwIfAborted();
    if (frame > 0) await delay((selected.intervalSeconds as number) * 1_000, signal);
    const captured = await capture();
    bytes += captured.byteLength;
    if (bytes > MAX_CAPTURE_BYTES)
      throw new Error("Captured images exceed the 20MB aggregate limit");
    for (const png of await selectImage(captured, selected)) {
      images.push({
        type: "image",
        data: Buffer.from(png).toString("base64"),
        mimeType: "image/png",
      });
    }
  }
  return images;
}

export async function selectImage(
  bytes: Uint8Array,
  options: VisionOptions,
): Promise<Uint8Array[]> {
  const image = await loadImage(bytes);
  const region = options.region ?? { x: 0, y: 0, width: 1, height: 1 };
  const sourceX = Math.round(region.x * image.width);
  const sourceY = Math.round(region.y * image.height);
  const sourceWidth = Math.max(1, Math.round(region.width * image.width));
  const sourceHeight = Math.max(1, Math.round(region.height * image.height));
  const scale = options.scale ?? 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const transformed = createCanvas(width, height);
  transformed
    .getContext("2d")
    .drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  if (options.cellSize === undefined) return [await transformed.encode("png")];
  const columns = Math.ceil(width / options.cellSize);
  const rows = Math.ceil(height / options.cellSize);
  const index = options.cellIndex ?? 0;
  if (index >= columns * rows)
    throw new Error(`Image cell offset ${index} exceeds the ${columns}x${rows} grid`);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const left = column * options.cellSize;
  const top = row * options.cellSize;
  const cellWidth = Math.min(options.cellSize, width - left);
  const cellHeight = Math.min(options.cellSize, height - top);
  const canvas = createCanvas(cellWidth, cellHeight);
  canvas
    .getContext("2d")
    .drawImage(transformed, left, top, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
  return [await canvas.encode("png")];
}

/** Creates the supported local desktop and isolated browser capture backend. */
export function createCaptureBackend(): CaptureBackend {
  return {
    async captureWindow(pid, signal) {
      signal?.throwIfAborted();
      if (isWsl()) return captureWslWindow(pid, signal);
      if (process.platform !== "linux" && process.platform !== "darwin")
        throw new Error(`Window capture is unsupported on ${process.platform}`);
      const { Window } = await import("node-screenshots");
      let windows: ReturnType<typeof Window.all>;
      try {
        windows = Window.all();
      } catch (error) {
        throw new Error(`Desktop window enumeration is unavailable: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      const window = windows.find((candidate) => {
        try {
          return candidate.pid() === pid;
        } catch {
          return false;
        }
      });
      if (window === undefined)
        throw new Error(`No capturable desktop window belongs to PID ${pid}`);
      const image = await window.captureImage();
      signal?.throwIfAborted();
      return new Uint8Array(await image.toPng());
    },
    async captureDisplay(index, signal) {
      signal?.throwIfAborted();
      if (isWsl()) return captureWslDisplay(index, signal);
      if (
        process.platform !== "linux" &&
        process.platform !== "darwin" &&
        process.platform !== "win32"
      )
        throw new Error(`Display capture is unsupported on ${process.platform}`);
      const { Monitor } = await import("node-screenshots");
      let monitors: ReturnType<typeof Monitor.all>;
      try {
        monitors = Monitor.all();
      } catch (error) {
        throw new Error(`Desktop display enumeration is unavailable: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      const monitor = monitors[index];
      if (monitor === undefined)
        throw new Error(
          `Display index ${index} is unavailable; found ${monitors.length} display(s)`,
        );
      const image = await monitor.captureImage();
      signal?.throwIfAborted();
      return new Uint8Array(await image.toPng());
    },
    async captureUrl(url, signal) {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Web screenshots require an HTTP(S) URL");
      const { chromium } = await import("playwright-core");
      const executablePath = await resolveBrowser();
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        chromiumSandbox: false,
        timeout: 30_000,
      });
      const abort = (): void => {
        void browser.close();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
        signal?.throwIfAborted();
        return new Uint8Array(await page.screenshot({ type: "png", fullPage: true }));
      } finally {
        signal?.removeEventListener("abort", abort);
        await browser.close().catch(() => undefined);
      }
    },
  };
}

async function captureWslWindow(pid: number, signal?: AbortSignal): Promise<Uint8Array> {
  const script = new URL("windows-window-capture.ps1", import.meta.url);
  signal?.throwIfAborted();
  const { stdout: windowsScript } = await execFileAsync("wslpath", ["-w", script.pathname], {
    signal,
  });
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsScript.trim(),
      "-ProcessId",
      String(pid),
    ],
    { encoding: "buffer", maxBuffer: MAX_CAPTURE_BYTES, signal },
  );
  return new Uint8Array(stdout);
}

async function captureWslDisplay(index: number, signal?: AbortSignal): Promise<Uint8Array> {
  const script = new URL("windows-display-capture.ps1", import.meta.url);
  signal?.throwIfAborted();
  const { stdout: windowsScript } = await execFileAsync("wslpath", ["-w", script.pathname], {
    signal,
  });
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsScript.trim(),
      "-DisplayIndex",
      String(index),
    ],
    { encoding: "buffer", maxBuffer: MAX_CAPTURE_BYTES, signal },
  );
  return new Uint8Array(stdout);
}

function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.WSL_DISTRO_NAME !== undefined || os.release().toLowerCase().includes("microsoft"))
  );
}
async function resolveBrowser(): Promise<string> {
  const configured = process.env.PI_AGENT_IDE_BROWSER_PATH;
  if (configured !== undefined) return configured;
  const { stdout } = await execFileAsync("bash", [
    "-lc",
    "command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser",
  ]);
  const path = stdout.trim();
  if (path.length === 0)
    throw new Error("No Chrome or Chromium executable was found; set PI_AGENT_IDE_BROWSER_PATH");
  return path;
}
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Capture aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer.unref();
  });
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
