use zed_extension_api::{self as zed, settings::ContextServerSettings, Command, Project, Result};

/// FAFO context server: exposes `fafo_scan` and `fafo_resolve` to Zed's
/// Agent Panel by spawning the fafo-resolve MCP stdio server.
///
/// Settings (under `context_servers.fafo.settings` in settings.json):
///   api_key  — TYPESAFE_API_KEY (required only for fafo_resolve)
///   cli      — argv prefix for the resolver, default
///              "npx tsx /path/to/typesafeai-fafo/packages/cli/src/cli.ts"
///              (split on whitespace)
struct FafoExtension;

const DEFAULT_CLI: &str =
    "npx tsx /path/to/typesafeai-fafo/packages/cli/src/cli.ts";

impl zed::Extension for FafoExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &zed::ContextServerId,
        project: &Project,
    ) -> Result<Command> {
        let settings = ContextServerSettings::for_project("fafo", project)?;
        let get = |key: &str| {
            settings
                .settings
                .as_ref()
                .and_then(|s| s.get(key))
                .and_then(|v| v.as_str())
        };

        let cli = get("cli").unwrap_or(DEFAULT_CLI);
        let mut argv = cli.split_whitespace().map(String::from).collect::<Vec<_>>();
        if argv.is_empty() {
            return Err("fafo: empty cli setting".into());
        }
        argv.push("mcp".into());

        let command = argv.remove(0);
        let env = get("api_key")
            .map(|k| vec![("TYPESAFE_API_KEY".to_string(), k.to_string())])
            .unwrap_or_default();

        Ok(Command {
            command,
            args: argv,
            env,
        })
    }
}

zed::register_extension!(FafoExtension);
