#!/usr/bin/env bash
# Install the repo's skills into the agents that read a SKILL.md folder:
# Claude Code (.claude/skills), Cursor (.cursor/skills) and Codex (.codex/skills).
#
# Links each skill under skills/ into those directories, project scoped (inside
# the project where you run it). When symlinks are unavailable (Windows without
# developer mode, restricted filesystems) it copies the folder instead, and it
# repairs the text stubs that a committed symlink turns into on Windows.
# Idempotent. Ported from the SingHacks repo.
#
#   bash skills/install.sh                 participant skills: /xrpl-setup, /xrpl-status, /xrpl-feedback, /xrpl-session-analysis
#   bash skills/install.sh --organizer     also /xrpl-team-report (organizer side)
#   bash skills/install.sh --project DIR   install into DIR instead of the repo root (vendored installs)
#
# On Windows use Git Bash, or: powershell -ExecutionPolicy Bypass -File skills/install.ps1
set -u

SKILLS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SKILLS_DIR/.." && pwd)"
PROJECT_ROOT="$REPO_ROOT"
ORGANIZER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --organizer) ORGANIZER=1 ;;
    --project) shift; PROJECT_ROOT="$(cd "$1" && pwd)" ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

TARGETS=(".claude/skills" ".cursor/skills" ".codex/skills")

IS_WINDOWS=0
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

# relpath <from_dir> <to_path>, pure bash, no python dependency.
relpath() {
  local from="$1" to="$2" common="$1" back=""
  while [ "${to#"$common"/}" = "$to" ] && [ "$common" != "/" ] && [ -n "$common" ]; do
    common="$(dirname "$common")"
    back="../$back"
  done
  if [ "$common" = "/" ] || [ -z "$common" ]; then echo "$to"; return; fi
  echo "${back}${to#"$common"/}"
}

link_or_copy () {
  local src="$1" dest="$2"
  local rel
  rel="$(relpath "$(dirname "$dest")" "$src")"
  rm -rf "$dest"
  if [ "$IS_WINDOWS" -eq 0 ] && ln -s "$rel" "$dest" 2>/dev/null && [ -d "$dest" ]; then
    echo "linked  ${dest#"$PROJECT_ROOT"/} -> $rel"
    return 0
  fi
  rm -rf "$dest"
  if cp -R "$src" "$dest" 2>/dev/null; then
    echo "copied  ${dest#"$PROJECT_ROOT"/} (symlinks unavailable, copied the folder)"
    return 0
  fi
  echo "ERROR: could not link or copy into ${dest#"$PROJECT_ROOT"/}" >&2
  return 1
}

install_dir () {
  local base="$1" installed=0
  for skill_path in "$base"/*/; do
    [ -f "${skill_path}SKILL.md" ] || continue
    skill_path="${skill_path%/}"
    local name
    name="$(basename "$skill_path")"
    for t in "${TARGETS[@]}"; do
      mkdir -p "$PROJECT_ROOT/$t"
      link_or_copy "$skill_path" "$PROJECT_ROOT/$t/$name"
    done
    installed=$((installed + 1))
  done
  echo "$installed"
}

n="$(install_dir "$SKILLS_DIR" | tee /dev/stderr | tail -1)"
total="$n"
if [ "$ORGANIZER" -eq 1 ]; then
  m="$(install_dir "$REPO_ROOT/organizer/skills" | tee /dev/stderr | tail -1)"
  total=$((total + m))
fi

echo ""
echo "installed $total skill(s) into: ${TARGETS[*]} (project: $PROJECT_ROOT)"
echo "Cursor also reads .claude/skills and .codex/skills, so it is covered as well."
if [ "$IS_WINDOWS" -eq 1 ]; then
  echo "Windows detected: skills were copied rather than symlinked. Re-run after pulling changes."
fi
echo "Next: type /xrpl-status in your agent to check the hook is alive."
