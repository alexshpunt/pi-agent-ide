import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const run = promisify(execFile);
const repositoryRoot = process.cwd();
const validationRoot = path.resolve(repositoryRoot, ".agents/tmp/tool-capability-validation");
const requestedOutput = process.argv.slice(2).find((argument) => argument !== "--");
const output = path.resolve(requestedOutput ?? path.join(validationRoot, "run"));
const relativeOutput = path.relative(validationRoot, output);

if (relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) {
  throw new Error("Validation workspace must stay under .agents/tmp/tool-capability-validation");
}

await rm(output, { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });
await cp(path.resolve("validation/tool-capabilities/fixture"), output, { recursive: true });
await mkdir(path.join(output, "web"), { recursive: true });

await cp(
  path.resolve("validation/tool-capabilities/server.ts"),
  path.join(output, "web/server.ts"),
);
await writeFile(
  path.join(output, "web/index.html"),
  "<!doctype html><title>Tool validation</title><main><h1>Rendered marker</h1><p>browser-capability-marker</p></main>\n",
);
await writeFile(
  path.join(output, "web/rendered.html"),
  "<!doctype html><main><p id=marker></p></main><script>document.querySelector('#marker').textContent = 'automatic-browser-fallback-marker';</script>\n",
);
await writeFile(
  path.join(output, "web/large.txt"),
  Array.from({ length: 2200 }, (_, index) => `large-output-line-${String(index + 1)}`).join("\n"),
);
await writeFile(
  path.join(output, "scenarios/oversized-first-line.txt"),
  `oversized-first-line-${"x".repeat(60 * 1024)}\nsecond line remains readable\n`,
);
await cp(path.resolve("assets/banner.png"), path.join(output, "sample.png"));
await writeFile(path.join(output, "sample.pdf"), createPdf("pdf-capability-marker"));
await writeFile(
  path.join(output, "README.md"),
  "# Tool validation workspace\n\nThis disposable Git repository is generated for real Pi Agent IDE tool validation.\n",
);

await run("git", ["init", "--quiet"], { cwd: output });
await run("git", ["config", "user.name", "Pi Agent IDE Validator"], { cwd: output });
await run("git", ["config", "user.email", "validator@example.invalid"], { cwd: output });
await run("git", ["add", "."], { cwd: output });
await run("git", ["commit", "--quiet", "-m", "Create validation fixture"], { cwd: output });

process.stdout.write(`${output}\n`);

function createPdf(text: string): string {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }

  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${String(objects.length + 1)}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return pdf;
}
