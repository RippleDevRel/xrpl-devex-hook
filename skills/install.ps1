# Install the repo's skills into the agents that read a SKILL.md folder:
# Claude Code (.claude\skills), Cursor (.cursor\skills) and Codex (.codex\skills).
#
# PowerShell equivalent of install.sh for Windows, where symlinks committed in
# git check out as tiny text stubs and ln -s is unavailable. Copies each skill
# folder into the three target directories, overwriting any stale copy or broken
# stub. Idempotent. Run from the repo root:
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

function Install-SkillsFrom($base) {
  $count = 0
  Get-ChildItem -Path $base -Directory | ForEach-Object {
    $skill = $_
    if (-not (Test-Path (Join-Path $skill.FullName "SKILL.md"))) { return }
    foreach ($t in $Targets) {
      $dir = Join-Path $ProjectRoot $t
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $dest = Join-Path $dir $skill.Name
      if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
      Copy-Item -Recurse -Force -Path $skill.FullName -Destination $dest
      Write-Host "copied  $($dest.Substring($ProjectRoot.Length + 1))"
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
Write-Host "Skills were copied (not symlinked); re-run this after pulling new changes."
Write-Host "Next: type /xrpl-status in your agent to check the hook is alive."
