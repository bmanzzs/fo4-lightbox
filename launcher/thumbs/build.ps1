# Builds launcher\thumbs\build\LightboxThumbs.dll (Explorer .nif thumbnails) for a source copy of FO4 Lightbox, with the
# .NET Framework compiler that ships with Windows. tools\build_release.py builds the release copy itself.
$ErrorActionPreference = 'Stop'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$out = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force $out | Out-Null
& $csc -nologo -optimize+ -target:library -r:System.Drawing.dll -out:"$out\LightboxThumbs.dll" (Join-Path $PSScriptRoot 'LightboxThumbs.cs')
if ($LASTEXITCODE) { throw 'build failed' }
"Built $out\LightboxThumbs.dll"
