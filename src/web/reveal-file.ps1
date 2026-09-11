# Reveals a file in Explorer AND brings that window to the foreground.
#
# NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
#
# Why this is not just "explorer /select,<path>":
# Windows has a foreground lock - a background process (our Node server) is not allowed
# to steal focus, so the newly opened Explorer window shows up behind / minimised in the
# taskbar. This script opens it and then explicitly activates the window.
#
# Usage:  powershell -File reveal-file.ps1 -Path "D:\...\settings.ini"
# Output: RESULT ok=1 hwnd=1234567 foreground=1 attempts=...
# Exit code: 0 when the window was found (foreground may still be 0 - see the report).

param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class Win32Foreground
{
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

    private const int SW_RESTORE = 9;
    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    // Returns true when the window ended up in the foreground.
    public static bool Activate(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;

        ShowWindow(hwnd, SW_RESTORE);          // un-minimise if needed
        SwitchToThisWindow(hwnd, true);        // what the taskbar itself uses
        SetForegroundWindow(hwnd);
        if (GetForegroundWindow() == hwnd) return true;

        // The foreground lock can still refuse us. Tapping ALT makes Windows treat the
        // call as user-initiated, which lifts the lock. Last resort, but harmless.
        keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
        SetForegroundWindow(hwnd);

        return GetForegroundWindow() == hwnd;
    }

    public static bool IsForeground(IntPtr hwnd)
    {
        return GetForegroundWindow() == hwnd;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null

$full = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $full)) {
    [Console]::Error.WriteLine("file not found: $full")
    exit 1
}

$folder = [System.IO.Path]::GetDirectoryName($full)
$leaf = [System.IO.Path]::GetFileName($full)

# 1. ask Explorer to show the folder with the file selected
Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $full + '"') | Out-Null

# 2. find that window (Explorer may reuse an existing window instead of opening a new one)
$shell = New-Object -ComObject Shell.Application
$hwnd = [IntPtr]::Zero
$attempts = 0

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 150
    $attempts++

    foreach ($w in @($shell.Windows())) {
        try {
            $loc = [string]$w.LocationURL
            if (-not $loc) { continue }

            $decoded = [System.Uri]::UnescapeDataString($loc)
            $decoded = $decoded -replace '^file:///', ''
            $decoded = $decoded -replace '/', '\'

            if ($decoded.TrimEnd('\') -ieq $folder.TrimEnd('\')) {
                $candidate = [IntPtr][int64]$w.HWND
                $selected = ''
                try {
                    $item = $w.Document.FocusedItem
                    if ($item) { $selected = [string]$item.Path }
                } catch { }

                # Prefer the window that actually has our file selected
                if ($selected -ieq $full -or $hwnd -eq [IntPtr]::Zero) {
                    $hwnd = $candidate
                }
                if ($selected -ieq $full) { break }
            }
        } catch { }
    }

    if ($hwnd -ne [IntPtr]::Zero) { break }
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output ("RESULT ok=0 hwnd=0 foreground=0 attempts=$attempts")
    exit 0
}

# 3. give it a moment to finish laying out, then bring it to the front
Start-Sleep -Milliseconds 250
$foreground = [Win32Foreground]::Activate($hwnd)
Start-Sleep -Milliseconds 150
$foreground = [Win32Foreground]::IsForeground($hwnd)

Write-Output ("RESULT ok=1 hwnd=$($hwnd.ToInt64()) foreground=$(if ($foreground) { 1 } else { 0 }) attempts=$attempts")
