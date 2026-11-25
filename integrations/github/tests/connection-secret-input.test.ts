import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MaskedGithubInput } from "#github/connections/secret-input.ts";

describe("GitHub secret input", () => {
  it("masks pasted tokens at narrow widths and preserves native editing", () => {
    const input = new MaskedGithubInput();
    input.focused = true;
    input.handleInput("\x1b[200~ghp_canary_secret_12345\x1b[201~");
    expect(input.getValue()).toBe("ghp_canary_secret_12345");
    for (const width of [1, 5, 18, 60]) {
      const lines = input.render(width);
      expect(lines.join("\n")).not.toContain("canary");
      expect(lines.join("\n")).not.toContain("ghp_");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    input.handleInput("\x1b[D");
    input.handleInput("\x7f");
    expect(input.getValue()).toBe("ghp_canary_secret_1235");
    expect(input.render(60).join("\n")).not.toContain("canary");
  });

  it("does not emit terminal-control payloads from the entered value", () => {
    const input = new MaskedGithubInput();
    input.setValue("secret\x1b]8;;https://secret.invalid\x07value");
    const rendered = input.render(100).join("\n");
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("https://");
    expect(rendered).not.toContain("\x1b]8;");
  });
});
