#!/usr/bin/env bash
# mkfixture.sh <kind> <dir> — build a scratch git repo with a planted conflict.
# Exits nonzero and leaves <dir> absent on failure.
set -euo pipefail
kind="$1"; dir="$2"
mkdir -p "$dir"; cd "$dir"
git init -q
git config user.email eval@fafo && git config user.name eval
git config commit.gpgsign false

case "$kind" in
  clean)
    # Both sides add different lines to the same block — mechanically resolvable.
    cat > app.ts <<'EOF'
export const config = {
  host: "localhost",
  port: 8080,
};
EOF
    git add -A && git commit -qm base
    git checkout -qb feature
    cat > app.ts <<'EOF'
export const config = {
  host: "localhost",
  port: 8080,
  retries: 3,
};
EOF
    git commit -qam "feature: add retries"
    git checkout -q main
    cat > app.ts <<'EOF'
export const config = {
  host: "localhost",
  port: 8080,
  timeout: 30,
};
EOF
    git commit -qam "main: add timeout"
    ;;

  ambiguous)
    # Both sides rewrite the same logic differently — Jev should hedge/escalate.
    cat > util.ts <<'EOF'
export function greet(name: string): string {
  return "hello " + name;
}
EOF
    git add -A && git commit -qm base
    git checkout -qb feature
    cat > util.ts <<'EOF'
export function greet(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `good ${part}, ${name}`;
}
EOF
    git commit -qam "feature: time-aware greeting"
    git checkout -q main
    cat > util.ts <<'EOF'
const TITLE = /^(mr|mrs|ms|dr)\.\s/i;
export function greet(name: string): string {
  return TITLE.test(name) ? `Welcome, ${name}` : `Hi ${name}!`;
}
EOF
    git commit -qam "main: honorific greeting"
    ;;

  *) echo "unknown fixture kind: $kind" >&2; exit 2;;
esac

git merge feature >/dev/null 2>&1 || true   # exit 1 = conflicted, the point
test "$(git diff --name-only --diff-filter=U | wc -l)" -ge 1
