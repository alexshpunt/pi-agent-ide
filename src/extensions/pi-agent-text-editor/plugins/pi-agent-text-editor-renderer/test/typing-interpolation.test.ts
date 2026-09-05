import { afterEach, describe, expect, test, vi } from "vitest";

import { TypingInterpolation } from "#src/typing-interpolation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("typing interpolation", () => {
  test("TS-02 segments only the appended suffix and the grapheme at its join", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const interpolation = new TypingInterpolation();
    interpolation.observe("prefix é", 0);
    segment.mockClear();

    interpolation.observe("prefix é👩‍💻", 20);

    expect(segment).toHaveBeenCalledTimes(1);
    expect(segment.mock.calls[0]?.[0]).not.toContain("prefix");
    expect(segment.mock.calls[0]?.[0]?.length).toBeLessThanOrEqual("é👩‍💻".length);

    interpolation.observe("prefix é👩‍💻", 40);
    expect(segment).toHaveBeenCalledTimes(1);
  });

  test("TS-02 applies suffix segmentation to targets and preserves Unicode graphemes", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const interpolation = new TypingInterpolation();
    interpolation.setTarget("start é", 0);
    segment.mockClear();
    interpolation.setTarget("start é👩‍💻 family👨‍👩‍👧‍👦", 20);

    expect(segment).toHaveBeenCalledTimes(1);
    expect(segment.mock.calls[0]?.[0]).not.toContain("start");
    expect(segment.mock.calls[0]?.[0]?.length).toBeLessThanOrEqual("é👩‍💻 family👨‍👩‍👧‍👦".length);

    interpolation.finish();
    for (let now = 40; !interpolation.caughtUp && now < 2_000; now += 20) {
      interpolation.advance(now);
    }
    expect(interpolation.visibleText).toBe("start é👩‍💻 family👨‍👩‍👧‍👦");
  });

  test.each(["observe", "setTarget"] as const)(
    "TS-02 advances combining-mark completion through the %s route",
    (route) => {
      const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
      const interpolation = new TypingInterpolation();
      if (route === "observe") {
        interpolation.observe("prefix e", 0);
      }
      interpolation.setTarget("prefix e", 0);
      interpolation.finish();
      for (let now = 20; !interpolation.caughtUp && now < 2_000; now += 20) {
        interpolation.advance(now);
      }
      expect(interpolation.visibleText).toBe("prefix e");

      segment.mockClear();
      if (route === "observe") {
        interpolation.observe("prefix é", 20);
      }
      interpolation.setTarget("prefix é", 20);
      expect(segment).toHaveBeenCalled();
      expect(
        segment.mock.calls.every(
          ([input]) => !input.includes("prefix") && input.length <= "é".length,
        ),
      ).toBe(true);
      const target = "prefix é";
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const boundaries = new Set(["", ...graphemePrefixes(segmenter, target)]);
      const visibleValues = [interpolation.visibleText];
      for (let now = 40; !interpolation.caughtUp && now < 2_000; now += 20) {
        interpolation.advance(now);
        visibleValues.push(interpolation.visibleText);
      }

      for (const visible of visibleValues) {
        expect(boundaries).toContain(visible);
      }
      expect(interpolation.visibleText).toBe(target);
    },
  );

  test("TS-02 allows CRLF without prefix segmentation", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const crlf = new TypingInterpolation();
    crlf.setTarget("alpha", 0);
    segment.mockClear();
    crlf.setTarget("alpha\r\nbeta 👩‍💻", 20);
    expect(segment).toHaveBeenCalledTimes(1);
    expect(segment.mock.calls[0]?.[0]).not.toContain("alpha");
    expect(segment.mock.calls[0]?.[0]?.length).toBeLessThanOrEqual("a\r\nbeta 👩‍💻".length);

    crlf.finish();
    for (let now = 40; !crlf.caughtUp && now < 2_000; now += 20) {
      crlf.advance(now);
    }
    expect(crlf.visibleText).toBe("alpha\r\nbeta 👩‍💻");
  });

  test("TS-02 keeps every intermediate visible value at a grapheme boundary", () => {
    const target = "prefix é👩‍💻";
    const interpolation = new TypingInterpolation();
    interpolation.setTarget(target, 0);
    interpolation.finish();
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let prefix = "";
    const boundaries = new Set([
      "",
      ...[...segmenter.segment(target)].map(({ segment }) => {
        prefix += segment;
        return prefix;
      }),
    ]);

    for (let now = 20; !interpolation.caughtUp && now < 2_000; now += 20) {
      interpolation.advance(now);
      expect(boundaries).toContain(interpolation.visibleText);
    }
    expect(interpolation.visibleText).toBe(target);
  });

  test("TS-02 does not rebuild the visible prefix for repeated reads", () => {
    const join = vi.spyOn(Array.prototype, "join");
    const interpolation = new TypingInterpolation();
    interpolation.setTarget("emoji 👩‍💻 suffix", 0);
    interpolation.finish();
    for (let now = 20; !interpolation.caughtUp && now < 2_000; now += 20) {
      interpolation.advance(now);
    }

    join.mockClear();
    const first = interpolation.visibleText;
    const joinsAfterFirst = join.mock.calls.length;
    const second = interpolation.visibleText;

    expect(first).toBe("emoji 👩‍💻 suffix");
    expect(second).toBe(first);
    expect(joinsAfterFirst).toBeGreaterThan(0);
    expect(join.mock.calls.length).toBe(joinsAfterFirst);
  });

  test("TS-02 keeps rewind and non-prefix targets exact", () => {
    const interpolation = new TypingInterpolation();
    interpolation.setTarget("first 👩‍💻", 0);
    interpolation.finish();
    for (let now = 20; !interpolation.caughtUp && now < 2_000; now += 20) {
      interpolation.advance(now);
    }
    expect(interpolation.visibleText).toBe("first 👩‍💻");

    expect(interpolation.setTarget("second é", 2_000)).toBe(true);
    for (let now = 2_020; !interpolation.caughtUp && now < 4_000; now += 20) {
      interpolation.advance(now);
    }
    expect(interpolation.visibleText).toBe("second é");
  });

  test("keeps a large playback backlog within the lag budget", () => {
    const interpolation = new TypingInterpolation();
    const target = "x".repeat(35_000);
    interpolation.setTarget(target, 0);

    for (let now = 250; now <= 2_000; now += 250) {
      interpolation.advance(now);
    }

    expect(interpolation.visibleText).toBe(target);
  });
  test("keeps an urgent deadline while a preview target is still being prepared", () => {
    const interpolation = new TypingInterpolation();
    const target = "x".repeat(35_000);
    interpolation.finish(0, 300);
    interpolation.setTarget(target, 100);

    interpolation.advance(200);
    interpolation.advance(300);

    expect(interpolation.visibleText).toBe(target);
  });

  test("keeps the finish deadline after an intermediate target drains", () => {
    const interpolation = new TypingInterpolation();
    interpolation.setTarget("short", 0);
    interpolation.finish(0, 300);
    interpolation.advance(100);
    expect(interpolation.visibleText).toBe("short");
    interpolation.advance(150);
    const target = "short" + "x".repeat(35_000);
    interpolation.setTarget(target, 200);
    interpolation.advance(250);
    interpolation.advance(300);
    expect(interpolation.visibleText).toBe(target);
  });

  test("uses a shorter drain deadline when later output is already available", () => {
    const interpolation = new TypingInterpolation();
    const target = "x".repeat(35_000);
    interpolation.setTarget(target, 0);
    interpolation.finish(0, 300);

    for (let now = 100; now <= 300; now += 100) {
      interpolation.advance(now);
    }

    expect(interpolation.visibleText).toBe(target);
  });

  function graphemePrefixes(segmenter: Intl.Segmenter, text: string): readonly string[] {
    let prefix = "";
    return [...segmenter.segment(text)].map(({ segment }) => {
      prefix += segment;
      return prefix;
    });
  }
});
