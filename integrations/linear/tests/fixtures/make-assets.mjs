import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// Generate tiny, valid fixtures without converting or uploading any user's files.
const directory = path.resolve(process.argv[2] ?? ".tmp/assets");
await mkdir(directory, { recursive: true });
const content = "BT /F1 18 Tf 50 740 Td (Linear artifact verification PDF) Tj ET\n";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const name = Buffer.from("verification.txt");
const body = Buffer.from("Linear binary verification\n", "utf8");
let crc = 0xffffffff;
for (const byte of body) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
}
crc = (crc ^ 0xffffffff) >>> 0;
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(body.length, 18);
local.writeUInt32LE(body.length, 22);
local.writeUInt16LE(name.length, 26);
const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4);
central.writeUInt16LE(20, 6);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(body.length, 20);
central.writeUInt32LE(body.length, 24);
central.writeUInt16LE(name.length, 28);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length + name.length, 12);
end.writeUInt32LE(local.length + name.length + body.length, 16);
const zip = Buffer.concat([local, name, body, central, name, end]);
for (const [filename, bytes] of [
  ["linear-verification.pdf", Buffer.from(pdf)],
  ["linear-verification.zip", zip],
]) {
  await writeFile(path.join(directory, filename), bytes);
  console.log(
    JSON.stringify({
      file: path.join(directory, filename),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
}
