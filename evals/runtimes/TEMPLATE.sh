# TEMPLATE.sh — copy to <runtime>.sh and fill in. Contract:
#
#   rt_fake_home <with|without> <fixture-cwd> → echo path to a prepared
#       HOME dir. Must contain whatever auth the CLI needs (symlinks to
#       $REAL_HOME are fine — keychain-authorized CLIs need nothing), plus
#       whatever bypasses interactive trust/consent prompts for
#       <fixture-cwd> (devin: trusted_workspaces.json; others: TBD per
#       runtime). The `with` arm
#       additionally installs BOTH surfaces in this runtime's conventions:
#         - the skill  ($FAFO_SKILL — a dir containing SKILL.md) placed
#           wherever this runtime loads skills from
#         - the MCP server declared in this runtime's config format:
#           command `npx`, args `["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]`
#       The `without` arm installs neither — same auth, no surfaces.
#
#   rt_invoke <prompt-file> <cwd> <transcript-out> <home>
#       Run the agent headless in <cwd> with HOME=<home>; write a
#       transcript/tool-trace to <transcript-out> (any format — graders
#       regex over raw text). Return the agent's exit code.
#       Pass through TYPESAFE_API_KEY (already in env).
#
# Recon per runtime: `<cli> --help` for the headless flag (-p/--print/
# exec/chat --non-interactive/...), `ls ~/.<tool>` for config layout,
# docs for its MCP config format. Keep flags minimal — the eval measures
# discovery, not prompt engineering.

FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() { echo "TODO: rt_fake_home $1 $2" >&2; return 2; }
rt_invoke()    { echo "TODO: rt_invoke" >&2; return 2; }
