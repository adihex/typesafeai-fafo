import { build } from "esbuild";

const minify = process.argv.includes("--minify");

// VS Code extensions load via require(); emit CJS. "vscode" is provided by
// the extension host — everything else (@fafo/core TS source, the SDK) is
// bundled into a single file.
await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: !minify,
  minify,
});
