# Installs the stride command built by scripts/build.mjs --windows: dist\stride.exe into
# %LOCALAPPDATA%\Programs\stride, or the folder -Dest names. Run from the repository:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Upgrading is the same: the new build replaces the old, and both builds are named. PATH is not changed: it says how.
param([string]$Dest = (Join-Path $env:LOCALAPPDATA "Programs\stride"))
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "..\dist\stride.exe"
if (-not (Test-Path $src)) { Write-Output "no dist\stride.exe: build it first with node scripts/build.mjs --windows <node.exe>"; exit 1 }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$exe = Join-Path $Dest "stride.exe"
$old = ""
if (Test-Path $exe) { $old = ((& $exe --version 2>$null) -split ":")[0] }
Copy-Item $src "$exe.new" -Force
Move-Item "$exe.new" $exe -Force
$new = ((& $exe --version) -split ":")[0]
if ($old) { Write-Output "installed: $exe, $new (was $old)" } else { Write-Output "installed: $exe, $new" }
$onPath = ($env:PATH -split ";") | Where-Object { $_.TrimEnd("\") -ieq $Dest.TrimEnd("\") }
if (-not $onPath) { Write-Output "add $Dest to your PATH to type stride anywhere" }
Write-Output "next: stride guide, and for VS Code: stride vscode, then code --install-extension stride-*.vsix"
