<#
  Update the Orion Quests auto-update edition.

  Vencord's in-app updater does `git pull` + rebuild but does NOT run `pnpm install` first,
  so if an upstream update bumps a build dependency the in-Discord rebuild says "Build failed".
  This script does the full pull + pnpm install + build + restart, which fixes that.
#>
$ErrorActionPreference = 'Stop'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$InstallDir = Join-Path $env:LOCALAPPDATA 'OrionVencord'
$PluginSrc  = Join-Path $PSScriptRoot 'plugin'
$PluginRepoUrl = 'https://github.com/nyxxbit/discord-quest-completer'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Fail($m) { Write-Host ""; Write-Host "  ERROR: $m" -ForegroundColor Red; Write-Host ""; try { Read-Host 'Press Enter to exit' } catch {}; exit 1 }
function Step([string]$what, [scriptblock]$run) {
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $run } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). See output above." }
}

if (-not (Test-Path (Join-Path $InstallDir '.git'))) { Fail "No OrionVencord install found at $InstallDir. Run INSTALL-autoupdate.cmd first." }
if (-not (Test-Path $PluginSrc)) { Fail "plugin source folder not found next to this script. Extract the whole zip." }

Info "Updating Vencord source..."
$global:LASTEXITCODE = 0; $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
git -C $InstallDir pull --ff-only --quiet
$pc = $LASTEXITCODE; $ErrorActionPreference = $prev
if ($pc -ne 0) {
    Warn "  Fast-forward failed - hard-resetting to origin/main..."
    Step 'git fetch' { git -C $InstallDir fetch --depth 1 --quiet origin main }
    Step 'git reset' { git -C $InstallDir reset --hard --quiet FETCH_HEAD }
}

Info "Updating the plugin..."
$dest = Join-Path $InstallDir 'src\userplugins\orionQuests'

# Installs from v4.10.4 onward have the plugin as its own git checkout, so pull it. Older
# installs have a plain copied folder with no .git, and for those the only source of a newer
# plugin is the zip this script sits in, which is why UPDATE.cmd used to silently keep people
# on the version they first downloaded. Convert those to a clone on the spot so it is the last
# time it happens.
$pulled = $false
if (Test-Path (Join-Path $dest '.git')) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git -C $dest pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) {
        git -C $dest fetch --depth 1 --quiet origin HEAD
        git -C $dest reset --hard --quiet FETCH_HEAD
    }
    $pulled = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $prev
    if ($pulled) { Good "  Plugin updated from git." }
}

if (-not $pulled) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
    git clone --depth 1 --quiet $PluginRepoUrl $dest 2>&1 | Out-Null
    $ok = ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $dest 'index.tsx')))
    $ErrorActionPreference = $prev
    if ($ok) {
        Good "  Plugin converted to a git checkout; future updates pull automatically."
    } else {
        Warn "  Couldn't reach GitHub for the plugin, using the copy in this zip instead."
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item (Join-Path $PluginSrc '*') $dest -Recurse -Force
    }
}

Push-Location $InstallDir
try {
    Info "Installing dependencies..."
    Step 'pnpm install' { corepack pnpm install }
    Info "Building..."
    Step 'pnpm build' { corepack pnpm run build }
    if (-not (Select-String -Path 'dist\renderer.js' -Pattern 'OrionQuests' -SimpleMatch -Quiet)) { Fail "the plugin is missing from the rebuilt Vencord." }
} finally { Pop-Location }

Good "Updated. Restarting Discord..."
Get-Process Discord, DiscordCanary, DiscordPTB, DiscordSystemHelper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
foreach ($f in @('Discord', 'DiscordCanary', 'DiscordPTB')) {
    $u = Join-Path $env:LOCALAPPDATA "$f\Update.exe"
    if (Test-Path $u) { Start-Process $u -ArgumentList '--processStart', "$f.exe" -ErrorAction SilentlyContinue; break }
}
Write-Host ""
try { Read-Host 'Press Enter to close' } catch {}
