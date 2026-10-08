import { once } from "node:events";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createServer } from "node:http";
import { expect, test, vi } from "vitest";
import { createSshWebResolver } from "#src/backend/web-owner.js";
import { createHtmlContentConverter } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/src/html-converter.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as processChannels from "#src/backend/ssh-channel.js";
import { fetchSshWebResponse } from "#src/backend/web-http.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createWebResolver } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/resolver.js";
import { createWebSearchResolver } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/search.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import type { ContentHost } from "pi-agent-resource";
import { startSshFixture } from "./support/ssh-fixture.js";
import { startSshWebFixture } from "./support/ssh-web-fixture.js";
import { captureSshBrowserImage, readSshBrowserPage } from "#src/backend/web-browser.js";

test("explicit target HTTP uses its native proxy environment and preserves read-only URL identity", async () => {
  const requests: string[] = [];
  const proxy = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Owned café target page\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No private proxy address");
  const fixture = await startSshFixture(
    {},
    { http_proxy: `http://127.0.0.1:${address.port}`, no_proxy: "" },
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const host = {
      convert: vi.fn<ContentHost["convert"]>(async (input) => [
        { type: "text", text: new TextDecoder().decode(input.bytes) },
      ]),
    };
    const resolver = createWebResolver(host, { owner: createSshWebResolver(host, registry) });
    const url = "http://lpt149-owned.invalid/note?value=42#section";
    await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toBeInstanceOf(Error);
    const source = `web:ssh://fixture/${url}`;
    const result = await resolver.tryResolve(source, { cwd: "/controller" });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved" || !result.resource.read)
      throw new Error("No target web resource");
    expect(result.resource.source).toBe(source);
    expect(result.resource.write).toBeUndefined();
    await expect(result.resource.read({})).resolves.toEqual([
      { type: "text", text: "Owned café target page\n" },
    ]);
    expect(requests).toEqual(["http://lpt149-owned.invalid/note?value=42"]);
    expect(host.convert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "http://lpt149-owned.invalid/note?value=42",
        mediaType: "text/plain; charset=utf-8",
      }),
      expect.anything(),
    );
    const search = createWebSearchResolver(resolver);
    const hits = await search.tryResolve({ query: "café", path: source }, { cwd: "/controller" });
    expect(hits.kind).toBe("resolved");
    if (hits.kind !== "resolved") throw new Error("No target web search");
    const data = search.toScriptData?.(hits.payload, undefined);
    expect(JSON.stringify(data)).toContain(source);
    expect(JSON.stringify(data)).toContain("café");
    expect(JSON.stringify(data)).not.toContain("SEARCH#");
  } finally {
    try {
      await fixture.stop();
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}, 20_000);

test("target HTTP preserves redirects, media bytes, error status and bounded binary previews", async () => {
  const image = Buffer.from("89504e470d0a1a0a", "hex");
  const proxy = createServer((request, response) => {
    const route = new URL(request.url ?? "", "http://lpt149-owned.invalid").pathname;
    if (route === "/redirect") {
      response.writeHead(302, { location: "http://lpt149-owned.invalid/final" });
      response.end();
    } else if (route === "/image") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(image);
    } else if (route === "/pdf") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.7\nOwned document\n");
    } else if (route === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(8192, 42));
    } else if (route === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(Buffer.alloc(16 * 1024 * 1024 + 1, 42));
    } else {
      response.writeHead(route === "/missing" ? 404 : 200, { "content-type": "text/html" });
      response.end('<html><body><a href="./detail">café</a></body></html>');
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No private proxy address");
  const fixture = await startSshFixture(
    {},
    { http_proxy: `http://127.0.0.1:${address.port}`, no_proxy: "" },
  );
  const target = {
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  };
  const read = (route: string): Promise<Response> => {
    const url = new URL(`http://lpt149-owned.invalid/${route}`);
    return fetchSshWebResponse(target, url, `web:ssh://fixture/${url.href}`);
  };
  try {
    const redirect = await read("redirect");
    expect(redirect.url).toBe("http://lpt149-owned.invalid/final");
    expect(await redirect.text()).toContain('href="./detail"');
    const png = await read("image");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(image);
    const pdf = await read("pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toContain("%PDF-1.7");
    expect((await read("missing")).status).toBe(404);
    expect((await (await read("binary")).arrayBuffer()).byteLength).toBe(4096);
    await expect(read("large")).rejects.toMatchObject({ code: "BYTE_LIMIT" });
  } finally {
    try {
      await fixture.stop();
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}, 20_000);
test("target browser fallback runs page JavaScript and reuses readable HTML conversion", async () => {
  const proxy = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><script>
      document.body.insertAdjacentHTML('beforeend', '<article><h1>Owned café browser</h1><p>Target rendered value 43</p><a href="./detail">Detail</a><p style="display:none">Hidden target text</p></article>');
    </script></body></html>`);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No private proxy address");
  const fixture = await startSshWebFixture(`http://127.0.0.1:${address.port}`);
  try {
    const converter = createHtmlContentConverter();
    const host: Pick<ContentHost, "convert"> = {
      async convert(input, context) {
        const result = await converter.tryConvert(input, context);
        if (result.kind !== "converted") throw new Error("HTML conversion unavailable");
        return result.content;
      },
    };
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const resolver = createSshWebResolver(host, registry);
    const source = "web:ssh://fixture/http://lpt149-owned.invalid/browser";
    const selected = await resolver.tryResolve(source, { cwd: "/controller" });
    if (selected.kind !== "resolved" || !selected.resource.read)
      throw new Error("No target browser resource");
    const content = await selected.resource.read({});
    expect(JSON.stringify(content)).toContain("Owned café browser");
    expect(JSON.stringify(content)).toContain("Target rendered value 43");
    expect(JSON.stringify(content)).toContain("http://lpt149-owned.invalid/detail");
    expect(JSON.stringify(content)).not.toContain("Hidden target text");
    expect(selected.resource.source).toBe(source);
    expect(selected.resource.write).toBeUndefined();
  } finally {
    try {
      await fixture.stop();
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}, 20_000);
test("target browser captures native page pixels and refuses oversized documents", async () => {
  const proxy = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://lpt149-owned.invalid").pathname;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      route === "/oversized"
        ? '<html><body style="margin:0;width:20000px;height:20000px;background:red"></body></html>'
        : '<html><body style="margin:0;background:rgb(255,0,0)"></body></html>',
    );
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No private proxy address");
  const fixture = await startSshWebFixture(`http://127.0.0.1:${address.port}`);
  const target = {
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  };
  try {
    const url = new URL("http://lpt149-owned.invalid/red");
    const bytes = await captureSshBrowserImage(target, url, `web:ssh://fixture/${url.href}`);
    const image = await loadImage(Buffer.from(bytes));
    expect([image.width, image.height]).toEqual([1280, 720]);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    expect([...context.getImageData(640, 360, 1, 1).data]).toEqual([255, 0, 0, 255]);
    const large = new URL("http://lpt149-owned.invalid/oversized");
    await expect(
      captureSshBrowserImage(target, large, `web:ssh://fixture/${large.href}`),
    ).rejects.toMatchObject({ code: "BYTE_LIMIT" });
  } finally {
    try {
      await fixture.stop();
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}, 20_000);
test.each(["playwright", "chromium"] as const)(
  "missing target %s refuses HTML and image reads without controller browser fallback",
  async (missing) => {
    const fixture = await startSshWebFixture("http://127.0.0.1:1", {
      [missing === "playwright" ? "PI_AGENT_IDE_PLAYWRIGHT_PATH" : "PI_AGENT_IDE_BROWSER_PATH"]:
        "{workspace}/verified-absent-runtime",
    });
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const url = new URL("http://lpt149-owned.invalid/missing-runtime");
    const source = `web:ssh://fixture/${url.href}`;
    try {
      await expect(
        readSshBrowserPage(target, url, source, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        source,
      });
      await expect(captureSshBrowserImage(target, url, source)).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        source,
      });
    } finally {
      await fixture.stop();
    }
  },
  15_000,
);
test.each(["cancel", "deadline"] as const)(
  "target browser %s reaps its native browser and private profile before returning",
  async (mode) => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const proxy = createServer((request, response) => {
      if ((request.url ?? "").includes("/slow-browser")) markStarted?.();
      else response.end();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("No private proxy address");
    const fixture = await startSshWebFixture(`http://127.0.0.1:${address.port}`);
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const registry = new SshBackendRegistry([target]);
    const owner = registry.resolve(`ssh://fixture${fixture.workspace}`);
    if (!owner) throw new Error("No fixture owner");
    const marker = path.join(fixture.workspace, "browser-reader.pid");
    const originalStart = processChannels.startSshProcess;
    const interception = vi.spyOn(processChannels, "startSshProcess");
    const controller = new AbortController();
    try {
      interception.mockImplementationOnce((nativeTarget, command, args, cwd, context) =>
        originalStart(
          nativeTarget,
          command,
          [
            ...args.slice(0, 2),
            `await (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, String(process.pid));\n${args[2]}`,
            ...args.slice(3),
          ],
          cwd,
          context,
        ),
      );
      const url = new URL("http://lpt149-owned.invalid/slow-browser");
      const source = `web:ssh://fixture/${url.href}`;
      const pending = readSshBrowserPage(target, url, source, {
        signal: controller.signal,
        timeoutMs: 5000,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await Promise.race([
        started,
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Native browser did not start")), 4000);
          timer.unref();
        }),
      ]);
      const readerPid = Number(await readFile(marker, "utf8"));
      expect(Number.isSafeInteger(readerPid) && readerPid > 0).toBe(true);
      const inspected = await owner.backend.execute(
        "python3",
        [
          "-c",
          `import glob,json,re,sys
parent = int(sys.argv[1])
children = []
for directory in glob.glob('/proc/[0-9]*'):
    try:
        raw = open(directory + '/stat').read()
        if int(raw[raw.rfind(')') + 2:].split()[1]) != parent:
            continue
        args = open(directory + '/cmdline','rb').read().split(b'\\0')
        display = b' '.join(args).decode()
        if '--remote-debugging-pipe' not in display.split():
            continue
        profile_match = re.search(r'(?:^|\\s)--user-data-dir=(\\S+)', display)
        if not profile_match:
            continue
        profile = profile_match.group(1)
        children.append({'pid':int(directory.rsplit('/',1)[1]),'profile':profile})
    except (OSError,ValueError,StopIteration):
        continue
print(json.dumps(children))`,
          String(readerPid),
        ],
        fixture.workspace,
      );
      const manifest: unknown = JSON.parse(inspected.stdout.toString("utf8"));
      if (!Array.isArray(manifest) || manifest.length !== 1)
        throw new Error("No exact native browser child");
      const child: unknown = manifest[0];
      if (
        typeof child !== "object" ||
        child === null ||
        !("pid" in child) ||
        typeof child.pid !== "number" ||
        !("profile" in child) ||
        typeof child.profile !== "string"
      )
        throw new Error("Invalid native browser manifest");
      expect(child.profile).toMatch(/^\/tmp\/playwright_chromiumdev_profile-/u);
      if (mode === "cancel") controller.abort(new Error("Cancel native target browser"));
      expect(await pending).toMatchObject({
        code: mode === "cancel" ? "CANCELLED" : "TIMEOUT",
        source,
      });
      for (const pid of [readerPid, child.pid])
        await expect(
          readSshProcessMetadata(registry, `ssh://fixture${fixture.workspace}`, pid),
        ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(owner.backend.stat(child.profile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(proxy.listening).toBe(true);
    } finally {
      controller.abort();
      interception.mockRestore();
      try {
        await fixture.stop();
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
  15_000,
);
test("cancelling target HTTP reaps its actual reader before returning", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const proxy = createServer(() => {
    markStarted?.();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No private proxy address");
  const fixture = await startSshFixture(
    {},
    { http_proxy: `http://127.0.0.1:${address.port}`, no_proxy: "" },
  );
  const target = {
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  };
  const registry = new SshBackendRegistry([target]);
  const marker = path.join(fixture.workspace, "http-reader.pid");
  const start = processChannels.startSshProcess;
  const interception = vi.spyOn(processChannels, "startSshProcess");
  const controller = new AbortController();
  try {
    interception.mockImplementationOnce((owner, command, args, cwd, context) =>
      start(
        owner,
        command,
        [
          "-c",
          `import os; open(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\n${args[1]}`,
          ...args.slice(2),
        ],
        cwd,
        context,
      ),
    );
    const url = new URL("http://lpt149-owned.invalid/slow");
    const source = `web:ssh://fixture/${url.href}`;
    const pending = fetchSshWebResponse(target, url, source, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.race([
      started,
      new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Native HTTP request did not start")),
          5000,
        );
        timer.unref();
      }),
    ]);
    const pid = Number(await readFile(marker, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    controller.abort(new Error("Cancel actual target HTTP"));
    expect(await pending).toMatchObject({ code: "CANCELLED", source });
    await expect(
      readSshProcessMetadata(registry, `ssh://fixture${fixture.workspace}`, pid),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(proxy.listening).toBe(true);
  } finally {
    controller.abort();
    interception.mockRestore();
    try {
      await fixture.stop();
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}, 20_000);
