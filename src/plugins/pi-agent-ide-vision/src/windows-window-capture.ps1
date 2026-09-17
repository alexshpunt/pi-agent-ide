param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiAgentWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
'@
[PiAgentWindowCapture]::SetProcessDPIAware() | Out-Null
$process = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw "Process $ProcessId has no visible main window" }
$rect = New-Object PiAgentWindowCapture+RECT
if (-not [PiAgentWindowCapture]::GetWindowRect($handle, [ref]$rect)) { throw "GetWindowRect failed for process $ProcessId" }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "Process $ProcessId has empty window bounds" }
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::OpenStandardOutput().Write($stream.ToArray(), 0, $stream.Length)
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
