import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Windows does not expose NTFS ACLs through Node's mode bits. Check the actual
// security descriptors, including ancestors that could replace a private path.
const script = String.raw`
$ErrorActionPreference = 'Stop'
# Load the Windows PowerShell module explicitly. A PowerShell 7 parent can pass
# a PSModulePath that resolves Get-Acl to an incompatible Core-only module.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
try {
  $trusted += (New-Object System.Security.Principal.NTAccount('NT SERVICE', 'TrustedInstaller')).Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch {}
function Test-PrivatePath([string]$p) {
$leaf = $true
while ($p) {
  $acl = Get-Acl -LiteralPath $p
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl -or
      -not ($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)) { throw 'missing DACL' }
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        $ace.AceQualifier -notin @([System.Security.AccessControl.AceQualifier]::AccessAllowed, [System.Security.AccessControl.AceQualifier]::AccessDenied)) { throw 'unsupported ACE' }
  }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $trusted) { throw 'unsafe owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -in $trusted -or
        ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    $rights = [long][int]$rule.FileSystemRights
    if ($leaf) {
      # Synchronize alone does not grant access to the content or ACL.
      $mask = 0xffffffff -bxor 0x100000
    } else {
      # Delete, delete-child, change permissions/owner and generic write/all can
      # replace or take control of a descendant despite a private leaf ACL.
      $mask = 0x500d0040
    }
    if (($rights -band $mask) -ne 0) { throw 'unsafe access' }
  }
  $leaf = $false
  $parent = [System.IO.Directory]::GetParent($p)
  if ($null -eq $parent) { break }
  $p = $parent.FullName
}
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    Test-PrivatePath $p
    [Console]::Out.WriteLine('ok')
  } catch {
    [Console]::Out.WriteLine('unsafe')
  }
}
`;
const encoded = Buffer.from(script, "utf16le").toString("base64");

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Worker = { child: ChildProcessWithoutNullStreams; pending: Pending[]; failed: boolean };
let worker: Worker | undefined;

function startWorker(): Worker {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const state: Worker = { child, pending: [], failed: false };
  child.unref();
  const fail = () => {
    if (state.failed) return;
    state.failed = true;
    if (worker === state) worker = undefined;
    child.kill();
    for (const request of state.pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(new Error("Windows ACL check unavailable"));
    }
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const request = state.pending.shift();
    if (!request || !["ok", "unsafe"].includes(line)) return fail();
    clearTimeout(request.timer);
    if (line === "ok") request.resolve();
    else request.reject(new Error("Windows ACL check refused"));
  });
  // An idle verifier must not keep the CLI alive; the timer keeps it alive while in use.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    (stream as typeof stream & { unref?: () => void }).unref?.();
  }
  return state;
}
/** Fail closed when Windows cannot establish private access to an existing path. */
export async function assertWindowsPrivatePath(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const state = (worker ??= startWorker());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.child.kill();
    }, 120_000);
    state.pending.push({ resolve, reject, timer });
    state.child.stdin.write(Buffer.from(path, "utf8").toString("base64") + "\n");
  });
}
