// Keep CLI subprocesses on the fixture, including native paths with fixed production URLs.
const origin = new URL(process.env.LINEAR_TEST_HTTP_ORIGIN);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port)
  throw new Error("Invalid isolated HTTP fixture origin");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === origin.origin) return nativeFetch(input, init);
  if (url.href === "https://api.linear.app/graphql") {
    const target = new URL("/graphql", origin);
    return nativeFetch(input instanceof Request ? new Request(target, input) : target, init);
  }
  throw Object.assign(new Error("HTTP outside the isolated fixture is forbidden"), {
    code: "LINEAR_TEST_HTTP_OUTSIDE_FIXTURE",
  });
};
