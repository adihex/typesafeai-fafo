#!/usr/bin/env python3
# metrics.py <transcript> — extract A/B metrics from a devin -p export.
# Emits one JSON object: agent token totals, step/tool-call counts,
# skill-fire flag, and Jev token spend parsed out of fafo_resolve results.
import json
import re
import sys

try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("{}")
    sys.exit(0)

fm = d.get("final_metrics") or {}
steps = d.get("steps") or []

tool_calls = 0
tool_fns = {}
skill_fired = False
jev_in = jev_out = 0

def harvest_jev_usage(text):
    """fafo_resolve result content is a JSON string carrying usage totals."""
    global jev_in, jev_out
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

print(json.dumps({
    "agent_prompt_tokens": fm.get("total_prompt_tokens"),
    "agent_completion_tokens": fm.get("total_completion_tokens"),
    "agent_cached_tokens": fm.get("total_cached_tokens"),
    "agent_steps": fm.get("total_steps"),
    "tool_calls": tool_calls,
    "tool_fns": tool_fns,
    "skill_fired": skill_fired,
    "jev_input_tokens": jev_in,
    "jev_output_tokens": jev_out,
}))
