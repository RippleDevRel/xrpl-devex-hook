# Install the repo's skills into the agents that read a SKILL.md folder:
# Claude Code (.claude\skills), Cursor (.cursor\skills), Codex (.codex\skills)
# and Grok (.grok\skills).
#
# PowerShell equivalent of install.sh for Windows. Symlinks need Developer Mode
# or an elevated shell there, and a checkout with core.symlinks=false turns
# committed symlinks into tiny text stubs, so each skill folder is linked when a
# symbolic link can be created and copied otherwise (T25). Any stale copy or
# broken stub is replaced. Idempotent. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File skills\install.ps1 [-Organizer] [-Project DIR]
param(
  [switch]$Organizer,
  [string]$Project = ""
)
$ErrorActionPreference = "Stop"

$SkillsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $SkillsDir
$ProjectRoot = if ($Project) { (Resolve-Path $Project).Path } else { $RepoRoot }
$Targets   = @(".claude\skills", ".cursor\skills", ".codex\skills", ".grok\skills")

# Symlinks are off when git says so for this checkout; otherwise they are tried
# once and the copy fallback takes over if the link call fails.
$NoSymlinks = $false
try {
  $setting = (& git -C $ProjectRoot config --get core.symlinks 2>$null)
  if ($setting -eq "false") { $NoSymlinks = $true }
} catch { }
$Copied = 0
$Linked = 0

function Install-One($src, $dest) {
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  if (-not $script:NoSymlinks) {
    try {
      New-Item -ItemType SymbolicLink -Path $dest -Target $src -ErrorAction Stop | Out-Null
      $script:Linked++
      Write-Host "linked  $($dest.Substring($script:ProjectRoot.Length + 1)) -> $src"
      return
    } catch {
      if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    }
  }
  Copy-Item -Recurse -Force -LiteralPath $src -Destination $dest
  $script:Copied++
  Write-Host "copied  $($dest.Substring($script:ProjectRoot.Length + 1))"
}

function Install-SkillsFrom($base) {
  $count = 0
  Get-ChildItem -Path $base -Directory | ForEach-Object {
    $skill = $_
    if (-not (Test-Path (Join-Path $skill.FullName "SKILL.md"))) { return }
    foreach ($t in $Targets) {
      $dir = Join-Path $ProjectRoot $t
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Install-One $skill.FullName (Join-Path $dir $skill.Name)
    }
    $count++
  }
  return $count
}

$installed = Install-SkillsFrom $SkillsDir
if ($Organizer) { $installed += Install-SkillsFrom (Join-Path $RepoRoot "organizer\skills") }

Write-Host ""
Write-Host "installed $installed skill(s) into: $($Targets -join ', ') (project: $ProjectRoot)"
Write-Host "Cursor also reads .claude\skills and .codex\skills, so it is covered as well."
if ($Copied -gt 0) {
  $why = if ($NoSymlinks) { "core.symlinks=false in this checkout" } else { "symbolic links are not available here" }
  Write-Host "Skills were copied, not symlinked ($why); re-run this script after pulling new changes."
}
Write-Host "Next: type /xrpl-status in your agent to check the hook is alive."
