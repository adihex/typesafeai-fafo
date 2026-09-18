#!/usr/bin/env python3
# metrics.py — extract A/B metrics from a devin -p export, or a JSONL event
# transcript (codex --json / droid -o stream-json / pi --mode json / grok
# --output-format streaming-json). Standalone: metrics.py <transcript>.
# Importable: extract(path) -> dict.
import json
import sys


def _empty(shape):
    return {
        "transcript_shape": shape,
        "agent_prompt_tokens": None,
        "agent_completion_tokens": None,
        "agent_cached_tokens": None,
        "agent_steps": None,
        "tool_calls": 0,
        "tool_fns": {},
        "skill_fired": False,
        "mcp_called": False,
        "jev_input_tokens": 0,
        "jev_output_tokens": 0,
    }


def _extract_jsonl(path):
    """Parse line-delimited event transcripts from non-devin runtimes.

    Normalizes four shapes:
      codex  --json               item.started/item.completed {command_execution,
                                mcp_tool_call,...}; turn.completed.usage
      droid  -o stream-json       system/init{tools[]}; tool_call{toolName,
                                parameters}; result{num_turns}
      pi     --mode json          tool_execution_end{toolName}; message_*.
                                message.usage{input,output,cacheRead}
      grok   --output-format streaming-json   ACP session updates
    """
    m = _empty("jsonl")
    shape = "jsonl"
    turns = 0

    def bump(name):
        m["tool_calls"] += 1
        m["tool_fns"][name] = m["tool_fns"].get(name, 0) + 1

    def surface_probe(name, payload):
        # name = invoked tool/command name; payload = serialized args.
        # MCP use = the *name* is a fafo tool (avoids matching fafo_scan
        # strings inside SKILL.md text). Skill load = args touch the skill.
        if "fafo" in name:
            m["mcp_called"] = True
            m["skill_fired"] = True
        if "fafo" in payload and (
            name.lower() in ("skill", "read", "cat")
            or "fafo-resolve" in payload
            or "SKILL.md" in payload
        ):
            m["skill_fired"] = True

    try:
        lines = open(path).read().splitlines()
    except Exception:
        return {}
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type") or ""
        it = e.get("item") or {}

        # --- codex --json ------------------------------------------------
        if t in ("item.started", "item.completed") and it:
            shape = "codex-jsonl"
            if t == "item.completed" and it.get("type") not in (None, "agent_message"):
                bump(it.get("type") or "?")
                surface_probe(str(it.get("tool") or it.get("server") or ""),
                              json.dumps(it.get("command") or it.get("arguments") or {}))
        elif t == "turn.completed":
            shape = "codex-jsonl"
            turns += 1
            u = e.get("usage") or {}
            for src, dst in (("input_tokens", "agent_prompt_tokens"),
                             ("cached_input_tokens", "agent_cached_tokens"),
                             ("output_tokens", "agent_completion_tokens")):
                m[dst] = (m[dst] or 0) + int(u.get(src) or 0)
        # --- droid -o stream-json ---------------------------------------
        elif t == "system" and e.get("subtype") == "init":
            shape = "droid-stream"
            tools = [x for x in e.get("tools") or [] if "fafo" in x.lower()]
            if tools:
                m["mcp_called"] = False  # registered, not called — see tool_call
                m["tool_fns"]["__fafo_registered__"] = len(tools)
        elif t == "tool_call" and ("parameters" in e or "toolId" in e):
            # droid shape: {toolId, toolName, parameters} — grok's tool_call
            # carries toolCallId/rawInput instead and is handled below
            shape = "droid-stream"
            name = e.get("toolName") or "?"
            bump(name)
            surface_probe(name, json.dumps(e.get("parameters") or {}))
        elif t == "result" and "num_turns" in e:
            m["agent_steps"] = e.get("num_turns")
        # --- pi --mode json ----------------------------------------------
        elif t in ("tool_execution_end", "tool_execution_start"):
            shape = "pi-json"
            if t == "tool_execution_end":
                name = e.get("toolName") or "?"
                bump(name)
                surface_probe(name, json.dumps(e.get("parameters") or e.get("result") or {}))
        elif t in ("message_start", "message_end"):
            u = ((e.get("message") or {}).get("usage")) or {}
            if u:
                shape = "pi-json"
                m["agent_prompt_tokens"] = (m["agent_prompt_tokens"] or 0) + int(u.get("input") or 0)
                m["agent_cached_tokens"] = (m["agent_cached_tokens"] or 0) + int(u.get("cacheRead") or 0)
                m["agent_completion_tokens"] = (m["agent_completion_tokens"] or 0) + int(u.get("output") or 0)
        elif t == "turn_end":
            turns += 1
        # --- grok ACP -----------------------------------------------------
        elif "session" in t or t in ("sessionUpdate", "toolCall", "tool_call", "tool_call_update"):
            shape = "grok-acp"
            s = json.dumps(e)
            # grok wraps calls as use_tool{rawInput:{tool_name}} and reports
            # results as tool_call_update{rawOutput:{tool_name,server_name}}
            real = ((e.get("rawInput") or {}).get("tool_name")
                    or (e.get("rawOutput") or {}).get("tool_name") or "")
            srv = (e.get("rawOutput") or {}).get("server_name") or ""
            if t in ("tool_call", "toolCall"):
                bump(e.get("toolName") or real or "?")
            if "fafo" in real or "fafo" in srv:
                m["mcp_called"] = True
                m["skill_fired"] = True
            elif "fafo" in s:
                surface_probe(str(e.get("toolName") or ""), s)

    if shape == "jsonl" and m["tool_calls"] == 0:
        return {}  # not a shape we know — likely plain text
    m["transcript_shape"] = shape
    if m["agent_steps"] is None and turns:
        m["agent_steps"] = turns
    return m


def extract(path):
    try:
        d = json.load(open(path))
    except Exception:
        return _extract_jsonl(path)

    fm = d.get("final_metrics") or {}
    steps = d.get("steps") or []

    tool_calls = 0
    tool_fns = {}
    skill_fired = False
    jev_in = jev_out = 0

    def harvest_jev_usage(text):
        nonlocal jev_in, jev_out
        try:
            doc = json.loads(text)
        except Exception:
            return
        u = doc.get("usage") if isinstance(doc, dict) else None
        if isinstance(u, dict):
            jev_in += int(u.get("input_tokens") or 0)
            jev_out += int(u.get("output_tokens") or 0)

    for s in steps:
        for tc in s.get("tool_calls") or []:
            fn = tc.get("function_name") or "?"
            tool_calls += 1
            tool_fns[fn] = tool_fns.get(fn, 0) + 1
            args = tc.get("arguments") or {}
            if fn == "skill" and "fafo" in json.dumps(args):
                skill_fired = True
            if fn == "mcp_call_tool" and "fafo_resolve" in json.dumps(args):
                obs = s.get("observation") or {}
                for r in obs.get("results") or []:
                    harvest_jev_usage(r.get("content") or "")

    return {
        "transcript_shape": "devin-export",
        "agent_prompt_tokens": fm.get("total_prompt_tokens"),
        "agent_completion_tokens": fm.get("total_completion_tokens"),
        "agent_cached_tokens": fm.get("total_cached_tokens"),
        "agent_steps": fm.get("total_steps"),
        "tool_calls": tool_calls,
        "tool_fns": tool_fns,
        "skill_fired": skill_fired,
        "mcp_called": any(
            fn == "mcp_call_tool" and "fafo" in json.dumps(tc.get("arguments") or {})
            for s in steps for tc in s.get("tool_calls") or []
            for fn in [tc.get("function_name") or "?"]
        ),
        "jev_input_tokens": jev_in,
        "jev_output_tokens": jev_out,
    }


if __name__ == "__main__":
    print(json.dumps(extract(sys.argv[1])))
