# Generates assets\icon.ico (a 256x256 PNG-in-ICO).
#
# NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM,
# so non-ASCII text here would be mangled. No user-visible text lives in this script.
#
# Re-run this whenever you want to regenerate the icon:  powershell -File bin\make-icon.ps1

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# rounded-square background with a vertical gradient
$inset = 10
$rect = New-Object System.Drawing.Rectangle($inset, $inset, ($size - 2 * $inset), ($size - 2 * $inset))
$radius = 54
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc(($rect.Right - $radius), $rect.Y, $radius, $radius, 270, 90)
$path.AddArc(($rect.Right - $radius), ($rect.Bottom - $radius), $radius, $radius, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $radius), $radius, $radius, 90, 90)
$path.CloseFigure()

$rectF = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $rect.Width, $rect.Height)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rectF,
    [System.Drawing.Color]::FromArgb(255, 24, 42, 84),
    [System.Drawing.Color]::FromArgb(255, 76, 141, 255),
    90.0
)
$g.FillPath($bg, $path)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$center.LineAlignment = [System.Drawing.StringAlignment]::Center

# the music note glyph (U+266A) - Segoe UI Symbol ships with Windows
$noteFont = New-Object System.Drawing.Font(
    'Segoe UI Symbol', 128, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel
)
$noteRect = New-Object System.Drawing.RectangleF(0, 6, $size, $size)
$g.DrawString([string][char]0x266A, $noteFont, $white, $noteRect, $center)

# small MP3 label near the bottom
$labelFont = New-Object System.Drawing.Font(
    'Segoe UI', 34, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel
)
$labelRect = New-Object System.Drawing.RectangleF(0, 176, $size, 56)
$g.DrawString('MP3', $labelFont, $white, $labelRect, $center)

$g.Dispose()

# PNG bytes
$stream = New-Object System.IO.MemoryStream
$bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $stream.ToArray()
$bmp.Dispose()
$stream.Dispose()

# wrap the PNG in an ICO container (Vista+ accepts PNG payloads)
$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outPath = Join-Path $outDir 'icon.ico'

$file = [System.IO.File]::Create($outPath)
$writer = New-Object System.IO.BinaryWriter($file)
$writer.Write([UInt16]0)              # reserved
$writer.Write([UInt16]1)              # type: 1 = icon
$writer.Write([UInt16]1)              # image count
$writer.Write([Byte]0)                # width  0 means 256
$writer.Write([Byte]0)                # height 0 means 256
$writer.Write([Byte]0)                # palette colours
$writer.Write([Byte]0)                # reserved
$writer.Write([UInt16]1)              # colour planes
$writer.Write([UInt16]32)             # bits per pixel
$writer.Write([UInt32]$png.Length)    # payload size
$writer.Write([UInt32]22)             # payload offset (6 + 16)
$writer.Write($png)
$writer.Close()

Write-Output ('icon written: ' + $outPath + ' (' + (Get-Item $outPath).Length + ' bytes)')
