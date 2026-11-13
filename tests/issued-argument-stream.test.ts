import { expect, test } from "vitest";
import { IssuedArgumentStream } from "./support/issued-argument-stream.ts";

const token = "$issued-anchor:source-long-id:12";
const substitute = (value: string) => value.replaceAll(token, "ABC1234");

test("every split point keeps the complete issued token and JSON escapes intact", () => {
  const input = JSON.stringify({ text: `before ${token} after \\ " 😀 ${token}` });
  const expected = { text: 'before ABC1234 after \\ " 😀 ABC1234' };
  for (let split = 0; split <= input.length; split++) {
    const stream = new IssuedArgumentStream(substitute);
    const output =
      stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.push("", true);
    expect(JSON.parse(output), `split ${split}`).toEqual(expected);
    expect(stream.arguments).toEqual(expected);
  }
});

test("only the possible token suffix waits while ordinary text streams immediately", () => {
  const stream = new IssuedArgumentStream(substitute);
  expect(stream.push('{"text":"ready/$iss')).toBe('{"text":"ready/');
  expect(stream.arguments).toEqual({ text: "ready/" });
  expect(stream.push("ued-anchor:source-long-id:1")).toBe("");
  expect(stream.push('2",')).toBe('ABC1234",');
  expect(stream.arguments).toEqual({ text: "ready/ABC1234" });
  expect(stream.push('"next":true}')).toBe('"next":true}');
});

test("literal dollars, a final suffix and independent streams remain separate", () => {
  const first = new IssuedArgumentStream(substitute);
  const second = new IssuedArgumentStream(substitute);
  expect(first.push("$issued-anchor:source-long-id:")).toBe("");
  expect(second.push("$5 and $other")).toBe("$5 and $other");
  expect(second.push("$iss")).toBe("");
  expect(first.push("12", true)).toBe("ABC1234");
  expect(second.push("", true)).toBe("$iss");
});
