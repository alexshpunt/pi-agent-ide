import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const provisioner = fileURLToPath(new URL("./provision-ssh-debuggers.py", import.meta.url));
const load = `
import importlib.util, pathlib, tempfile, json
spec = importlib.util.spec_from_file_location('provisioner', __import__('sys').argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

test.each(["zip", "tar"])(
  "private %s extraction keeps executable bytes and rejects escapes",
  (format) => {
    const result = execFileSync(
      "python3",
      [
        "-B",
        "-c",
        `${load}
import io, tarfile, zipfile
parent = pathlib.Path(tempfile.gettempdir()) / '.tmp'
parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='debugger-archive-contract-', dir=parent) as directory:
 root = pathlib.Path(directory)
 archive = root / 'archive'
 zipped = __import__('sys').argv[2] == 'zip'
 if zipped:
  with zipfile.ZipFile(archive, 'w') as package:
   good = zipfile.ZipInfo('tool')
   good.external_attr = 0o100755 << 16
   package.writestr(good, b'owned executable bytes')
   package.writestr(str(root / 'escaped'), b'forbidden')
 else:
  with tarfile.open(archive, 'w') as package:
   good = tarfile.TarInfo('tool')
   good.mode = 0o755
   good.size = len(b'owned executable bytes')
   package.addfile(good, io.BytesIO(b'owned executable bytes'))
   bad = tarfile.TarInfo('link')
   bad.type = tarfile.SYMTYPE
   bad.linkname = str(root / 'escaped')
   package.addfile(bad)
 try:
  module.extract(archive, root / 'unpacked', zipped)
 except (ValueError, tarfile.FilterError):
  pass
 else:
  raise AssertionError('Escaping archive was accepted')
 assert not (root / 'escaped').exists()
 assert (root / 'unpacked/tool').read_bytes() == b'owned executable bytes'
 assert (root / 'unpacked/tool').stat().st_mode & 0o111
 print('escape rejected; owned executable preserved')
`,
        provisioner,
        format,
      ],
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("escape rejected; owned executable preserved");
  },
);

test("private cleanup refuses a different receipt before deleting anything", () => {
  const result = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `${load}
parent = pathlib.Path(tempfile.gettempdir()) / '.tmp'
parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='pi-ide-debuggers-', dir=parent) as directory:
 root = pathlib.Path(directory)
 sentinel = root / 'sentinel'
 sentinel.write_bytes(b'keep')
 receipt = root / 'receipt.json'
 receipt.write_text(json.dumps({'root': str(root / 'other')}))
 try:
  module.remove(str(root))
 except ValueError:
  pass
 else:
  raise AssertionError('Different receipt was accepted')
 assert sentinel.read_bytes() == b'keep'
 receipt.write_text(json.dumps({'root': str(root)}))
 module.remove(str(root))
 assert not root.exists()
 print('different receipt preserved; exact receipt removed')
`,
      provisioner,
    ],
    { encoding: "utf8" },
  );
  expect(result).toContain("different receipt preserved; exact receipt removed");
});
