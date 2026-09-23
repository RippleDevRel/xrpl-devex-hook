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
#   bash skills/install.sh --git-hook      also install scripts/precommit-secrets.mjs as .git/hooks/pre-commit of the project
#
# On Windows use Git Bash, or: powershell -ExecutionPolicy Bypass -File skills/install.ps1
set -u

SKILLS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SKILLS_DIR/.." && pwd)"
PROJECT_ROOT="$REPO_ROOT"
ORGANIZER=0
GIT_HOOK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --organizer) ORGANIZER=1 ;;
    --git-hook) GIT_HOOK=1 ;;
    --project) shift; PROJECT_ROOT="$(cd "$1" && pwd)" ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

TARGETS=(".claude/skills" ".cursor/skills" ".codex/skills" ".grok/skills")

IS_WINDOWS=0
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

# A checkout with core.symlinks=false turns symlinks into text stubs, so the
# skills must be copied there too (T25).
NO_SYMLINKS=0
if [ "$(git -C "$PROJECT_ROOT" config --get core.symlinks 2>/dev/null)" = "false" ]; then
  NO_SYMLINKS=1
fi

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
  if [ "$IS_WINDOWS" -eq 0 ] && [ "$NO_SYMLINKS" -eq 0 ] && ln -s "$rel" "$dest" 2>/dev/null && [ -d "$dest" ]; then
    echo "linked  ${dest#"$PROJECT_ROOT"/} -> $rel"
    return 0
  fi
  rm -rf "$dest"
  if cp -R "$src" "$dest" 2>/dev/null; then
    if [ "$NO_SYMLINKS" -eq 1 ]; then
      echo "copied  ${dest#"$PROJECT_ROOT"/} (core.symlinks=false in this checkout, copied the folder)"
    else
      echo "copied  ${dest#"$PROJECT_ROOT"/} (symlinks unavailable, copied the folder)"
    fi
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

# Optional pre-commit guard: refuses commits that hook/lib/redact.mjs would redact.
HOOK_MARKER="xrpl-devex-capture precommit-secrets"
install_git_hook () {
  local hooks_dir="$PROJECT_ROOT/.git/hooks" hook_file
  if [ ! -d "$PROJECT_ROOT/.git" ]; then
    echo "ERROR: --git-hook needs a git repository at $PROJECT_ROOT" >&2
    return 1
  fi
  mkdir -p "$hooks_dir"
  hook_file="$hooks_dir/pre-commit"
  if [ -f "$hook_file" ] && ! grep -q "$HOOK_MARKER" "$hook_file"; then
    echo "ERROR: $hook_file already exists and is not ours. Add this line to it instead:" >&2
    echo "  node \"$REPO_ROOT/scripts/precommit-secrets.mjs\" || exit 1" >&2
    return 1
  fi
  cat > "$hook_file" <<HOOK
#!/usr/bin/env sh
# $HOOK_MARKER: blocks commits containing seeds, keys or tokens. Remove this file to disable.
exec node "$REPO_ROOT/scripts/precommit-secrets.mjs"
HOOK
  chmod +x "$hook_file"
  echo "installed ${hook_file#"$PROJECT_ROOT"/} (pre-commit secrets guard)"
}

if [ "$GIT_HOOK" -eq 1 ]; then
  install_git_hook || exit 1
fi

echo ""
echo "installed $total skill(s) into: ${TARGETS[*]} (project: $PROJECT_ROOT)"
echo "Grok also reads .claude/skills; .grok/skills is installed for a dedicated copy."
if [ "$IS_WINDOWS" -eq 1 ] || [ "$NO_SYMLINKS" -eq 1 ]; then
  echo "Skills were copied rather than symlinked (Windows or core.symlinks=false). Re-run this script after pulling changes."
fi
echo "Next: type /xrpl-status in your agent to check the hook is alive."
