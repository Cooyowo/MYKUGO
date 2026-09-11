# Creates (or refreshes) the launcher shortcut inside the project folder.
#
# NOTE: ASCII-only on purpose - the display name is read from
# assets\shortcut-name.txt (UTF-8) instead of being hard-coded here,
# because Windows PowerShell 5.1 would mangle non-ASCII source text.
#
# Run it via bin\create-shortcut.cmd, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File bin\make-shortcut.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

$name = 'KugoToMP3'
$nameFile = Join-Path $root 'assets\shortcut-name.txt'
if (Test-Path $nameFile) {
    $raw = Get-Content -LiteralPath $nameFile -Raw -Encoding UTF8
    if ($raw -and $raw.Trim()) { $name = $raw.Trim() }
}

$lnkPath = Join-Path $root ($name + '.lnk')
$iconPath = Join-Path $root 'assets\icon.ico'
$startScript = Join-Path $root 'bin\start.ps1'

if (-not (Test-Path $startScript)) {
    throw ('missing launcher: ' + $startScript)
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powershell)) { $powershell = 'powershell.exe' }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)

$shortcut.TargetPath = $powershell
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Kugou .kgg converter (local web UI)'
$shortcut.WindowStyle = 7   # minimized, as a second line of defence against a visible window

if (Test-Path $iconPath) {
    $shortcut.IconLocation = $iconPath + ',0'
}

$shortcut.Save()

Write-Output ('shortcut created: ' + $lnkPath)
Write-Output ('  target     : ' + $shortcut.TargetPath)
Write-Output ('  arguments  : ' + $shortcut.Arguments)
Write-Output ('  icon       : ' + $shortcut.IconLocation)
Write-Output ('  windowStyle: ' + $shortcut.WindowStyle)
