import { requiredValue } from "../../../../../utils/required-value.js";
const DEFAULT_RATE = 240;
const MIN_RATE = 12;
const MAX_RATE = 1_600;
const RATE_WINDOW_MS = 600;
const PLAYBACK_BUFFER_MS = 75;
const MIN_BUFFER = 8;
const MAX_BUFFER = 40;
const MAX_START_DELAY_MS = 110;
const CATCH_UP_GAIN = 7;
const FINAL_DRAIN_MS = 40;
const MAX_FRAME_ELAPSED_MS = 80;
const MAX_GRAPHEMES_PER_FRAME = 24;
const MAX_FINAL_GRAPHEMES_PER_FRAME = 96;

export const TYPING_FRAME_INTERVAL_MS = 20;

interface ArrivalSample {
  readonly at: number;
  readonly length: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class TypingInterpolation {
  private observedCharacters: readonly string[] = [];
  private targetCharacters: readonly string[] = [];
  private visibleCount = 0;
  private arrivals: ArrivalSample[] = [];
  private firstTargetAt: number | undefined;
  private lastFrameAt: number | undefined;
  private credit = 0;
  private started = false;
  private finished = false;

  public observe(text: string, now: number): void {
    const characters = graphemes(text);

    if (sameCharacters(characters, this.observedCharacters)) {
      return;
    }

    const isExtendsPrevious =
      commonPrefixLength(this.observedCharacters, characters) === this.observedCharacters.length;

    if (!isExtendsPrevious) {
      this.arrivals = [];
    }

    const sample = { at: now, length: characters.length };
    const previous = this.arrivals.at(-1);

    if (previous?.at === now) {
      this.arrivals[this.arrivals.length - 1] = sample;
    } else {
      this.arrivals.push(sample);
    }

    this.observedCharacters = characters;
    this.pruneArrivals(now);
  }

  public setTarget(text: string, now: number): boolean {
    const characters = graphemes(text);
    const shared = commonPrefixLength(this.targetCharacters, characters);
    const isVisibleChanged = shared < this.visibleCount;

    if (isVisibleChanged) {
      this.visibleCount = shared;
      this.credit = 0;
    }

    this.targetCharacters = characters;
    this.firstTargetAt ??= now;
    this.lastFrameAt ??= now;
    return isVisibleChanged;
  }

  public finish(): void {
    this.finished = true;
    this.started = true;
  }

  public advance(now: number): boolean {
    const previousFrameAt = this.lastFrameAt;
    this.lastFrameAt = now;

    if (previousFrameAt === undefined) {
      return false;
    }

    const backlog = this.targetCharacters.length - this.visibleCount;

    if (backlog <= 0) {
      this.credit = 0;
      return false;
    }

    const rate = this.estimatedRate(now);
    const buffered = clamp(Math.round((rate * PLAYBACK_BUFFER_MS) / 1_000), MIN_BUFFER, MAX_BUFFER);

    if (!this.started) {
      const waited = now - (this.firstTargetAt ?? now);

      if (backlog < buffered && waited < MAX_START_DELAY_MS) {
        return false;
      }

      this.started = true;
    }

    const elapsed = clamp(now - previousFrameAt, 0, MAX_FRAME_ELAPSED_MS);
    const correction = (backlog - buffered) * CATCH_UP_GAIN;
    const normalSpeed = clamp(
      rate + correction,
      Math.max(MIN_RATE, rate * 0.35),
      Math.min(MAX_RATE, Math.max(360, rate * 2.5)),
    );
    const speed = this.finished
      ? Math.max(normalSpeed, (backlog * 1_000) / FINAL_DRAIN_MS)
      : normalSpeed;
    this.credit += (speed * elapsed) / 1_000;

    const frameLimit = this.finished ? MAX_FINAL_GRAPHEMES_PER_FRAME : MAX_GRAPHEMES_PER_FRAME;
    const step = Math.min(backlog, frameLimit, Math.floor(this.credit));

    if (step === 0) {
      return false;
    }

    this.visibleCount += step;
    this.credit -= step;
    return true;
  }

  public get visibleText(): string {
    return this.targetCharacters.slice(0, this.visibleCount).join("");
  }

  public get hasVisibleText(): boolean {
    return this.visibleCount > 0;
  }

  public get caughtUp(): boolean {
    return this.visibleCount === this.targetCharacters.length;
  }

  private estimatedRate(now: number): number {
    this.pruneArrivals(now);

    const first = this.arrivals[0];
    const last = this.arrivals.at(-1);

    if (
      first === undefined ||
      last === undefined ||
      last.at - first.at < 20 ||
      last.length <= first.length
    ) {
      return DEFAULT_RATE;
    }

    return clamp(((last.length - first.length) * 1_000) / (last.at - first.at), MIN_RATE, MAX_RATE);
  }

  private pruneArrivals(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;

    while (this.arrivals.length > 2 && requiredValue(this.arrivals[1]).at < cutoff) {
      this.arrivals.shift();
    }
  }
}

function graphemes(text: string): readonly string[] {
  return [...segmenter.segment(text)].map(({ segment }) => segment);
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  let index = 0;

  while (index < length && left[index] === right[index]) {
    index++;
  }

  return index;
}

function sameCharacters(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && commonPrefixLength(left, right) === left.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
