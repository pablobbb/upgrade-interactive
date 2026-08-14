#!/usr/bin/env bash
#
# capture-run.sh — snapshot a real-world `upgrade-interactive` run for later analysis.
#
# Run this from the *target project* (the one you're upgrading), not from the
# upgrade-interactive repo. Copy it anywhere, or invoke it by path.
#
#   ./capture-run.sh pre                      # before you run the tool
#   nui | tee /tmp/session.txt                # run the tool, keeping its output
#   ./capture-run.sh post --session /tmp/session.txt
#
# `pre` prints the exact `post` command to run, and leaves a marker file so
# `post` can find the same output directory on its own.
#
# Produces (see docs/field-report-2026-08-11.md §4 for what each is used for):
#
#   meta.txt                tool/node/npm/OS versions, dates
#   pre/  post/             package.json, package-lock.json, audit.json
#   session.txt             the tool's own output (supplied via --session)
#   build.log               post-run build, with exit code recorded in meta.txt
#   config/                 astro.config.*, vite.config.*, tsconfig.json, .npmrc, …
#
# The audit.json on each side is the single most important artifact: advisory
# databases drift, so re-auditing a lockfile weeks later does not reproduce what
# the tool actually saw.

set -euo pipefail

MARKER=".capture-run-current"

die() { printf 'capture-run: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

usage() {
  cat >&2 <<'EOF'
usage:
  capture-run.sh pre  [--out DIR]
  capture-run.sh post [--out DIR] [--session FILE] [--build CMD | --no-build]

  --out DIR       output directory (pre: defaults to a timestamped sibling of the
                  project; post: defaults to the directory recorded by `pre`)
  --session FILE  the tool's terminal output, e.g. from `nui | tee session.txt`
  --build CMD     command to run after the upgrade (default: `npm run build` if
                  the project defines a build script, otherwise skipped)
  --no-build      skip the post-upgrade build entirely
EOF
  exit 2
}

# --- shared -----------------------------------------------------------------

require_project() {
  [ -f package.json ] || die "no package.json here — run this from the project you're upgrading"
}

# npm audit exits non-zero whenever it finds anything, which is the normal case.
# An empty/!valid file would silently poison the analysis, so verify it parsed.
capture_audit() {
  local dest=$1
  npm audit --json >"$dest" 2>/dev/null || true
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$dest" 2>/dev/null; then
    printf '{"error":"npm audit produced no parseable JSON (offline?)"}\n' >"$dest"
    note "WARNING: npm audit produced no parseable JSON — recorded a placeholder"
  fi
}

capture_side() {
  local dir=$1
  mkdir -p "$dir"
  cp package.json "$dir/package.json"
  [ -f package-lock.json ] && cp package-lock.json "$dir/package-lock.json" \
    || note "WARNING: no package-lock.json — the analysis loses its ground truth"
  capture_audit "$dir/audit.json"
  node -e '
    const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = a.metadata && a.metadata.vulnerabilities;
    console.log("  audit: " + (v ? JSON.stringify(v) : "unavailable"));
  ' "$dir/audit.json"
}

capture_config() {
  local dir=$1
  mkdir -p "$dir"
  # Project config decides reachability (an Astro site with no SSR adapter cannot
  # be hit by the SSR-only advisories, say), so it is worth more than its size.
  for f in ./*.config.js ./*.config.mjs ./*.config.cjs ./*.config.ts \
           tsconfig.json jsconfig.json .npmrc .nvmrc; do
    [ -f "$f" ] && cp "$f" "$dir/" 2>/dev/null || true
  done
}

tool_version() {
  npx --no-install upgrade-interactive --version 2>/dev/null \
    || npx --no-install nui --version 2>/dev/null \
    || echo "unknown (record it manually)"
}

# --- pre --------------------------------------------------------------------

do_pre() {
  local out=""
  while [ $# -gt 0 ]; do
    case $1 in
      --out) out=${2:-}; [ -n "$out" ] || usage; shift 2 ;;
      *) usage ;;
    esac
  done

  require_project
  local name stamp
  # tr -d '\n' first: node -p's trailing newline would otherwise become a stray '-'.
  name=$(node -p 'require("./package.json").name || "project"' | tr -d '\n' | tr -c 'A-Za-z0-9._-' '-')
  stamp=$(date -u +%Y%m%d-%H%M)
  [ -n "$out" ] || out="../${name}-nui-run-${stamp}"
  mkdir -p "$out"
  out=$(cd "$out" && pwd)

  printf 'capturing PRE state\n'
  capture_side "$out/pre"
  capture_config "$out/config"

  {
    echo "captured_pre_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "project:          $(node -p 'const p=require("./package.json"); `${p.name}@${p.version||"?"}`')"
    echo "project_dir:      $(pwd)"
    echo "tool_version:     $(tool_version)"
    echo "node:             $(node -v)"
    echo "npm:              $(npm -v)"
    echo "os:               $(uname -srm)"
  } >"$out/meta.txt"

  printf '%s\n' "$out" >"$MARKER"

  printf '\nPRE captured: %s\n\n' "$out"
  note "now run the tool, keeping its output:"
  note "    nui | tee /tmp/nui-session.txt"
  note ""
  note "then:"
  note "    $0 post --session /tmp/nui-session.txt"
}

# --- post -------------------------------------------------------------------

do_post() {
  local out="" session="" build="" no_build=0
  while [ $# -gt 0 ]; do
    case $1 in
      --out) out=${2:-}; [ -n "$out" ] || usage; shift 2 ;;
      --session) session=${2:-}; [ -n "$session" ] || usage; shift 2 ;;
      --build) build=${2:-}; [ -n "$build" ] || usage; shift 2 ;;
      --no-build) no_build=1; shift ;;
      *) usage ;;
    esac
  done

  require_project
  if [ -z "$out" ]; then
    [ -f "$MARKER" ] || die "no --out given and no $MARKER found — pass --out DIR"
    out=$(cat "$MARKER")
  fi
  [ -d "$out/pre" ] || die "$out does not look like a capture dir (no pre/)"
  out=$(cd "$out" && pwd)

  printf 'capturing POST state\n'
  capture_side "$out/post"

  if [ -n "$session" ]; then
    [ -f "$session" ] || die "session file not found: $session"
    cp "$session" "$out/session.txt"
    note "session.txt captured"
  else
    note "WARNING: no --session given; the tool's own output will be missing"
  fi

  # The build answers "did the upgrade break anything", which the lockfiles cannot.
  local build_status="skipped"
  if [ "$no_build" -eq 0 ]; then
    if [ -z "$build" ] && node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)' 2>/dev/null; then
      build="npm run build"
    fi
    if [ -n "$build" ]; then
      note "running: $build"
      set +e
      ( eval "$build" ) >"$out/build.log" 2>&1
      build_status=$?
      set -e
      note "build exit=$build_status (build.log)"
    else
      note "no build script found — skipping (use --build CMD to force)"
    fi
  fi

  {
    echo "captured_post_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "build_command:     ${build:-none}"
    echo "build_exit:        $build_status"
  } >>"$out/meta.txt"

  rm -f "$MARKER"

  printf '\nPOST captured: %s\n\n' "$out"
  node -e '
    const fs = require("fs");
    const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
    const pre = read(process.argv[1]), post = read(process.argv[2]);
    const t = (a) => a && a.metadata && a.metadata.vulnerabilities;
    if (t(pre) && t(post)) {
      console.log("  advisories: " + t(pre).total + " -> " + t(post).total);
      console.log("  pre : " + JSON.stringify(t(pre)));
      console.log("  post: " + JSON.stringify(t(post)));
    }
  ' "$out/pre/audit.json" "$out/post/audit.json"
  printf '\n'
  note "zip it for sharing:"
  note "    (cd $(dirname "$out") && zip -rX $(basename "$out").zip $(basename "$out"))"
}

# --- main -------------------------------------------------------------------

[ $# -ge 1 ] || usage
cmd=$1; shift
case $cmd in
  pre)  do_pre "$@" ;;
  post) do_post "$@" ;;
  *)    usage ;;
esac
