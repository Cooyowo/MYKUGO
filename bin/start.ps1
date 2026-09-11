# Launches the local web UI with NO visible console window.
#
# NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM,
# so non-ASCII text here would be mangled. Chinese text comes from the app itself.
#
# Because the console is hidden, a failed start would otherwise be invisible -
# so if the server dies right away we pop a message box with its output.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$outLog = Join-Path $env:TEMP ('kugou-ui-out-' + $PID + '.log')
$errLog = Join-Path $env:TEMP ('kugou-ui-err-' + $PID + '.log')

# extra arguments are passed through, e.g. for testing:
#   start.ps1 --no-open --port 8796
$nodeArgs = @('src\web\server.js') + $args

$node = Start-Process -FilePath 'node' `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $root `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

# give it a moment to either bind the port or die
Start-Sleep -Seconds 4

if ($node.HasExited) {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $text = ''
    foreach ($f in @($errLog, $outLog)) {
        if (Test-Path $f) {
            $part = (Get-Content -LiteralPath $f -Raw -Encoding UTF8)
            if ($part) { $text += $part }
        }
    }
    if (-not $text) { $text = 'The server exited immediately without any output.' }
    [System.Windows.Forms.MessageBox]::Show(
        $text, 'KugoToMP3 - failed to start', 'OK', 'Error'
    ) | Out-Null
} else {
    $node.WaitForExit()
}

Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
