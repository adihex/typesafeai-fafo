"""FAFO — native Rune extension.

Registers a `fafo` command manual that adjudicates merge conflicts in the
current file (or every conflicted file with `fafo all`) by invoking the
fafo-resolve CLI. Escalated hunks — markers left in the file by design —
are pushed onto the file's location list so they can be walked with
location_next / location_prev, and every verdict lands as a notification.

Jev selects and verifies over an enumerated candidate set; it never
generates code. Low confidence or failed verification escalates — this
extension surfaces that honestly instead of hiding it.
"""

from __future__ import annotations

import json
import os
import re
import shlex

from rune_sdk.api import text as text_api
from rune_sdk.api import workspace as ws_api
from rune_sdk.api.browser import Client as BrowserClient, NotificationLevel
from rune_sdk.api.text import Client as TextClient, Token
from rune_sdk.api.text._types import Attributes, Coordinates, Location
from rune_sdk.extension import (
    Metadata,
    Permission,
    Workspace,
    serve_workspace_extension,
)

META = Metadata(
    developer_id="fafo",
    developer_email="",
    developer_key="",
    extension_id="fafo",
    extension_name="FAFO — Jev merge-conflict adjudicator",
    extension_version="0.1.0",
    permissions={
        Permission.COMMANDS,
        Permission.EDITOR,
        Permission.EXECUTE,
        Permission.FILE_SYSTEM,
        Permission.NOTIFICATIONS,
    },
)

DEFAULT_CLI = "fafo-resolve"
EXIT_MARK = "__FAFO_EXIT__:"


class _Sink:
    """Async byte sink for Cmd stdout/stderr capture."""

    def __init__(self) -> None:
        self.buf = bytearray()

    async def write(self, data: bytes, /) -> int:
        self.buf.extend(data)
        return len(data)

    def text(self) -> str:
        return self.buf.decode("utf-8", "replace")


async def _run(
    executor: ws_api.Client, argv: list[str], cwd: str, env: dict[str, str]
) -> tuple[int, str, str]:
    """Run argv via the workspace executor.

    fafo exits 1 on escalations — a normal outcome — but Process.wait()
    raises CommandError for any non-zero status. Wrap in sh so the real
    exit code arrives as a marker on stderr and the wrapper itself exits 0.
    """
    out, err = _Sink(), _Sink()
    quoted = " ".join(shlex.quote(a) for a in argv)
    script = f"{quoted}; c=$?; printf '%s%d\\n' '{EXIT_MARK}' \"$c\" >&2; exit 0"
    proc = await executor.start_command(
        ws_api.Cmd(
            path="sh",
            dir=cwd,
            args=["-c", script],
            env=[f"{k}={v}" for k, v in env.items()],
            stdout=out,
            stderr=err,
        )
    )
    try:
        await proc.wait()
    except Exception:
        pass
    stderr = err.text()
    m = re.search(re.escape(EXIT_MARK) + r"(\d+)", stderr)
    code = int(m.group(1)) if m else 2
    return code, out.text(), stderr


def _escalated_marker_rows(path: str) -> list[int]:
    """Rows (0-based) of conflict markers still present — i.e. escalated hunks."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return [i for i, line in enumerate(f) if line.startswith("<<<<<<<")]
    except OSError:
        return []


def _summaries(report: list) -> tuple[int, int, list[str]]:
    applied = escalated = 0
    lines: list[str] = []
    for f in report:
        name = os.path.basename(f.get("file", "?"))
        for d in f.get("outcomes", []):
            if d.get("action") == "apply":
                applied += 1
                conf = d.get("confidence")
                conf_s = f" conf {conf:.2f}" if isinstance(conf, (int, float)) else ""
                lines.append(f"{name}: {d.get('candidate','?')}{conf_s}")
            else:
                escalated += 1
                lines.append(f"{name}: escalated — {d.get('reason','?')}")
    return applied, escalated, lines


async def extend(w: Workspace, config: dict) -> None:
    cfg = config.get("fafo", {}) if isinstance(config.get("fafo"), dict) else {}
    cli = cfg.get("cli", os.environ.get("FAFO_CLI", DEFAULT_CLI))
    extra_env = {k: str(v) for k, v in cfg.get("env", {}).items()}
    if os.environ.get("TYPESAFE_API_KEY"):
        extra_env.setdefault("TYPESAFE_API_KEY", os.environ["TYPESAFE_API_KEY"])

    executor = w.executor()
    notes: BrowserClient = w.notifications()
    editor: TextClient = w.editor()

    async def handle(cmd: text_api.Command) -> None:
        check = "check" in cmd.args
        scope_all = "all" in cmd.args

        cwd = executor.root() or os.getcwd()
        if scope_all:
            code, out, _ = await _run(
                executor, ["git", "diff", "--name-only", "--diff-filter=U"], cwd, {}
            )
            targets = [os.path.join(cwd, p) for p in out.split() if p.strip()]
            uris = [executor.uri(os.path.relpath(p, cwd)) for p in targets]
        else:
            if not cmd.uri or cmd.uri.scheme not in ("file", "ws"):
                await notes.notify(
                    NotificationLevel.WARN, "fafo: no file context — use `fafo all`"
                )
                return
            path = cmd.uri.path
            if not os.path.isabs(path):
                path = os.path.join(cwd, path.lstrip("/"))
            targets, uris = [path], [cmd.uri]

        if not targets:
            await notes.notify(NotificationLevel.INFO, "fafo: no conflicted files")
            return

        await notes.notify(
            NotificationLevel.INFO,
            f"fafo: {'checking' if check else 'resolving'} {len(targets)} file(s)…",
        )

        argv = shlex.split(cli) + ["resolve"]
        if check:
            argv.append("--check")
        argv.append("--json")
        argv.extend(targets)

        code, out, err = await _run(executor, argv, cwd, extra_env)

        try:
            report = json.loads(out)
        except json.JSONDecodeError:
            detail = (err or out).strip().splitlines()
            detail = [d for d in detail if not d.startswith(EXIT_MARK)]
            await notes.notify(
                NotificationLevel.ERROR,
                f"fafo: CLI failed ({detail[-1] if detail else 'no output'})",
            )
            return

        applied, escalated, lines = _summaries(report)
        for line in lines:
            await notes.notify(
                NotificationLevel.WARN if "escalated" in line else NotificationLevel.SUCCESS,
                f"fafo: {line}",
            )

        for path, uri in zip(targets, uris):
            rows = _escalated_marker_rows(path)
            if not rows:
                continue
            locs = [
                Location(
                    from_=Coordinates(x=0, y=row),
                    to=Coordinates(x=0, y=row),
                    attr=Attributes(),
                    message="escalated — resolve manually or with a generative model",
                    icon="!",
                )
                for row in rows
            ]
            try:
                await editor.set_location_list(
                    Token(uri=uri), text_api.LocationPriority.ERROR, "fafo", locs
                )
            except Exception:
                pass

        level = NotificationLevel.SUCCESS if escalated == 0 else NotificationLevel.WARN
        verb = "would apply" if check else "applied"
        await notes.notify(
            level,
            f"fafo: {applied} hunk(s) {verb}, {escalated} escalated (exit {code})",
        )

    manual = text_api.CommandManual(
        name="fafo",
        summary="Resolve merge conflicts — Jev picks from enumerated candidates",
        synopsis="[check|all]",
        commands=(
            text_api.CommandManual(
                name="check",
                summary="Dry-run: report decisions without writing",
                synopsis="",
            ),
            text_api.CommandManual(
                name="all",
                summary="Resolve every conflicted file in the workspace",
                synopsis="",
            ),
        ),
    )
    await w.register_command(manual, handle)


def main() -> None:
    serve_workspace_extension(extend, META)


if __name__ == "__main__":
    main()
