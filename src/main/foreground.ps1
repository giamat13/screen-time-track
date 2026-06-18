# Persistent foreground-window watcher.
# Emits one compact JSON line per poll: { pid, name, desc, title, t }
# Usage: powershell -NoProfile -File foreground.ps1 <intervalSeconds>
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$interval = 2.0
if ($args.Count -ge 1) {
  try { $interval = [double]$args[0] } catch { $interval = 2.0 }
}
if ($interval -lt 1) { $interval = 1 }

while ($true) {
  try {
    $h = [Fg]::GetForegroundWindow()
    [uint32]$procId = 0
    [void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)

    $sb = New-Object System.Text.StringBuilder 1024
    [void][Fg]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()

    $name = ''
    $desc = ''
    if ($procId -gt 0) {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) {
        $name = $proc.ProcessName
        try { if ($proc.Description) { $desc = [string]$proc.Description } } catch { }
      }
    }

    $obj = [pscustomobject]@{
      pid   = [int]$procId
      name  = $name
      desc  = $desc
      title = $title
      t     = (Get-Date).ToString('o')
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
    [Console]::Out.Flush()
  } catch {
    Write-Output '{"error":"poll"}'
    [Console]::Out.Flush()
  }
  Start-Sleep -Seconds $interval
}
