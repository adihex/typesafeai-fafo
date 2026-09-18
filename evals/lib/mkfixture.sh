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

  hard)
    # Multi-file difficulty gradient, diff3 conflict style (base sections).
    git config merge.conflictStyle diff3

    # 1. config.ts — both sides add different keys (safe: expect apply)
    cat > config.ts <<'EOF'
export const db = {
  host: "localhost",
  port: 5432,
  pool: { min: 1, max: 4 },
};
EOF
    # 2. auth.ts — ours deletes a legacy fn, theirs extends it (drop-vs-keep)
    cat > auth.ts <<'EOF'
export function hash(pw: string): string {
  return `sha1:${pw.length}:${pw}`;
}

export function legacyCheck(pw: string): boolean {
  return pw.length > 0;
}

export function verify(pw: string, hash: string): boolean {
  return hash === `sha1:${pw.length}:${pw}`;
}
EOF
    # 3. util.ts — both sides rewrite the same logic (ambiguous: expect escalate)
    cat > util.ts <<'EOF'
export function retryDelay(attempt: number): number {
  return attempt * 100;
}
EOF
    # 4. notes.md — setext underlines + long rules + one real conflict
    cat > notes.md <<'EOF'
Release Notes
=============

Section one
-----------

Body text that stays identical on both sides.

=============================================
(a long ascii rule, not a conflict separator)

Checklist
---------

- item one
- item two
EOF
    # 5. api.ts — interleaved edits inside one region (weave territory)
    cat > api.ts <<'EOF'
export function route(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  if (url.pathname === "/version") return new Response("1.0");
  return new Response("not found", { status: 404 });
}
EOF
    git add -A && git commit -qm base
    git checkout -qb feature

    # feature side
    cat > config.ts <<'EOF'
export const db = {
  host: "localhost",
  port: 5432,
  pool: { min: 1, max: 4 },
  ssl: true,
};
EOF
    cat > auth.ts <<'EOF'
export function hash(pw: string): string {
  return `sha1:${pw.length}:${pw}`;
}

export function legacyCheck(pw: string): boolean {
  return pw.length > 0 && !pw.includes(" ");
}

export function verify(pw: string, hash: string): boolean {
  return hash === `sha1:${pw.length}:${pw}`;
}
EOF
    cat > util.ts <<'EOF'
export function retryDelay(attempt: number): number {
  const base = Math.min(100 * 2 ** attempt, 5000);
  return base + Math.random() * base * 0.2;
}
EOF
    cat > notes.md <<'EOF'
Release Notes
=============

Section one
-----------

Body text that stays identical on both sides.

=============================================
(a long ascii rule, not a conflict separator)

Checklist
---------

- item one
- item two
- item three (feature)
EOF
    cat > api.ts <<'EOF'
export function route(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  if (url.pathname === "/ready") return new Response("ready");
  if (url.pathname === "/version") return new Response("1.0");
  return new Response("not found", { status: 404 });
}
EOF
    git commit -qam "feature branch edits"
    git checkout -q main

    # main side
    cat > config.ts <<'EOF'
export const db = {
  host: "localhost",
  port: 5432,
  pool: { min: 1, max: 4 },
  statementTimeout: 5000,
};
EOF
    cat > auth.ts <<'EOF'
export function hash(pw: string): string {
  return `sha1:${pw.length}:${pw}`;
}

export function verify(pw: string, hash: string): boolean {
  return hash === `sha1:${pw.length}:${pw}`;
}
EOF
    cat > util.ts <<'EOF'
const SCHEDULE = [50, 200, 800, 2000];
export function retryDelay(attempt: number): number {
  return SCHEDULE[Math.min(attempt, SCHEDULE.length - 1)];
}
EOF
    cat > notes.md <<'EOF'
Release Notes
=============

Section one
-----------

Body text that stays identical on both sides.

=============================================
(a long ascii rule, not a conflict separator)

Checklist
---------

- item one
- item two
- added by main
EOF
    cat > api.ts <<'EOF'
export function route(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  if (url.pathname === "/metrics") return new Response("metrics");
  if (url.pathname === "/version") return new Response("1.0");
  return new Response("not found", { status: 404 });
}
EOF
    git commit -qam "main branch edits"
    ;;

  *) echo "unknown fixture kind: $kind" >&2; exit 2;;
esac

git merge feature >/dev/null 2>&1 || true   # exit 1 = conflicted, the point
test "$(git diff --name-only --diff-filter=U | wc -l)" -ge 1
