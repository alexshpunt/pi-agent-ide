import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, test } from "vitest";

import {
  captureImages,
  configureVision,
  parseDisplaySource,
  isExecutableAllowed,
  parseVisionView,
  readProcess,
  selectImage,
  validateVisionOptions,
} from "#src/plugins/pi-agent-ide-vision/src/vision.js";
import { AgentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";

describe("display resources", () => {
  test("uses display zero when no index is supplied", () => {
    expect(parseDisplaySource("display:")).toBe(0);
  });

  test("accepts a zero-based display index after a hash", () => {
    expect(parseDisplaySource("display:#2")).toBe(2);
  });

  test("rejects malformed display selectors", () => {
    expect(() => parseDisplaySource("display:2")).toThrow("display:#N");
    expect(() => parseDisplaySource("display:#-1")).toThrow("display:#N");
  });
});

describe("vision view parameters", () => {
  test("uses configured sequence defaults", () => {
    expect(
      parseVisionView(["sequence"], {
        durationSeconds: 2,
        intervalSeconds: 0.5,
        scale: 0.5,
      }),
    ).toMatchObject({ mode: "sequence", durationSeconds: 2, intervalSeconds: 0.5, scale: 0.5 });
  });

  test("parses named sequence parameters and a normalized region", () => {
    expect(
      parseVisionView(["sequence:duration=4,interval=1,scale=0.75,region=0.25,0.25,0.5,0.5"], {
        durationSeconds: 2,
        intervalSeconds: 0.5,
        scale: 0.5,
      }),
    ).toEqual({
      mode: "sequence",
      durationSeconds: 4,
      intervalSeconds: 1,
      scale: 0.75,
      region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });
  });

  test("rejects sequences above the frame limit", () => {
    expect(() =>
      parseVisionView(["sequence:duration=10,interval=0.1"], {
        durationSeconds: 2,
        intervalSeconds: 0.5,
        scale: 0.5,
      }),
    ).toThrow("20 frames");
  });
});

test("matches allowlisted executables by exact file name without case sensitivity", () => {
  configureVision({ allowedExecutables: "Unity.exe, UnrealEditor.exe" });
  expect(isExecutableAllowed("C:\\Program Files\\Unity\\Unity.exe")).toBe(true);
  expect(isExecutableAllowed("/opt/UnrealEditor.exe --project demo")).toBe(true);
  expect(isExecutableAllowed("C:\\Tools\\NotUnity.exe")).toBe(false);
  configureVision({});
});

describe("Agent vision image bounds", () => {
  test("requires a grid cell size when an image offset is selected", () => {
    expect(() => validateVisionOptions({ mode: "image", cellIndex: 1 })).toThrow(
      "offset requires limit",
    );
  });

  test("uses cell zero when limit is supplied without offset", () => {
    expect(validateVisionOptions({ mode: "image", cellSize: 200 })).toEqual({
      mode: "image",
      cellSize: 200,
    });
  });

  test("selects one row-major image cell as a PNG", async () => {
    const canvas = createCanvas(8, 4);
    const context = canvas.getContext("2d");
    context.fillStyle = "red";
    context.fillRect(0, 0, 4, 4);
    context.fillStyle = "blue";
    context.fillRect(4, 0, 4, 4);

    const images = await selectImage(await canvas.encode("png"), {
      mode: "image",
      cellSize: 4,
      cellIndex: 1,
    });

    expect(images).toHaveLength(1);
    await expect(loadImage(images[0] as Uint8Array)).resolves.toEqual(
      expect.objectContaining({ width: 4, height: 4 }),
    );
  });

  test("applies region then scale before selecting a grid cell", async () => {
    const canvas = createCanvas(800, 400);
    const images = await selectImage(await canvas.encode("png"), {
      mode: "image",
      scale: 0.5,
      region: { x: 0.25, y: 0, width: 0.5, height: 1 },
      cellSize: 100,
      cellIndex: 0,
    });

    await expect(loadImage(images[0] as Uint8Array)).resolves.toEqual(
      expect.objectContaining({ width: 100, height: 100 }),
    );
  });

  test("returns a bounded sequence of native image blocks", async () => {
    const canvas = createCanvas(2, 2);
    const png = await canvas.encode("png");
    let captures = 0;
    const images = await captureImages(
      async () => {
        captures += 1;
        return png;
      },
      { mode: "sequence", durationSeconds: 1, intervalSeconds: 0.5, scale: 1 },
    );
    expect(captures).toBe(3);
    expect(images).toHaveLength(3);
    expect(images.every((image) => image.mimeType === "image/png")).toBe(true);
  });
});

test("process metadata marks a registry PID as Agent IDE owned", async () => {
  const registry = new AgentIdeProcessRegistry();
  registry.add({
    id: "test",
    list: () => [
      {
        source: "shell:test",
        kind: "terminal",
        title: "test",
        description: "test process",
        status: "running",
        pid: process.pid,
        owned: true,
        renderSummary: () => [],
        renderDetail: () => ({ render: () => [] }) as never,
        stop: async () => undefined,
      },
    ],
    onDidChange: () => () => undefined,
  });

  await expect(readProcess(process.pid, registry)).resolves.toMatchObject({
    pid: process.pid,
    owned: true,
    source: "shell:test",
  });
});
