param([Parameter(Mandatory=$true)][int]$DisplayIndex)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiAgentDisplayCapture {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[PiAgentDisplayCapture]::SetProcessDPIAware() | Out-Null
$displays = [System.Windows.Forms.Screen]::AllScreens
if ($DisplayIndex -lt 0 -or $DisplayIndex -ge $displays.Length) {
  throw "Display index $DisplayIndex is unavailable; found $($displays.Length) display(s)"
}
$bounds = $displays[$DisplayIndex].Bounds
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "Display $DisplayIndex has empty bounds" }
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::OpenStandardOutput().Write($stream.ToArray(), 0, $stream.Length)
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
