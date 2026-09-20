import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

test("release metadata and documentation invariants validate", () => {
  const result = run(process.execPath, ["tools/validate-release.js"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Markdown links checked:/);
  assert.match(result.stdout, /Errors: 0/);
});

test("supported release bundle contains CLI and Agentic Workflows only", () => {
  const result = run(process.execPath, ["tools/package-release.js", "--check"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Supported surfaces: CLI, Agentic Workflows/);
  assert.match(result.stdout, /Extension paths: 0/);
  assert.match(result.stdout, /Reproducible archive: verified/);
});

test("agentic installer creates an isolated, buildable, conflict-aware target runtime", () => {
  const target = mkdtempSync(join(tmpdir(), "wikikb-agentic-install-"));
  try {
    const initialized = run("git", ["init", "--initial-branch", "trunk", target]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const targetPackage = '{"name":"target-application","private":true}\n';
    writeFileSync(join(target, "package.json"), targetPackage);

    const unconfirmed = run(process.execPath, [
      "tools/install-agentic.js",
      "--target",
      target,
      "--default-branch",
      "trunk",
    ]);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stderr, /PRIVATE knowledge-base repository/);

    const installed = run(process.execPath, [
      "tools/install-agentic.js",
      "--target",
      target,
      "--confirm-private-repo",
      "--default-branch",
      "trunk",
    ]);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.match(installed.stdout, /WikiKB files installed/);
    assert.equal(readFileSync(join(target, "package.json"), "utf8"), targetPackage);
    assert.ok(existsSync(join(target, ".github", "wikikb", "package-lock.json")));
    assert.ok(existsSync(join(target, ".github", "aw", "actions-lock.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(target, ".github", "workflows", "aw.json"), "utf8")), { maintenance: false });
    assert.ok(existsSync(join(target, ".github", "wikikb", "vendor", "soma", "manifest.json")));
    assert.doesNotMatch(readFileSync(join(target, ".github", "workflows", "compile-kb.md"), "utf8"), /^\s{2}push:/m);
    assert.match(readFileSync(join(target, ".github", "workflows", "sync-labels.yml"), "utf8"), /branches: \["trunk"\]/);
    assert.match(readFileSync(join(target, ".github", "workflows", "query-kb.md"), "utf8"), /\.github\/wikikb/);

    const dependencies = run("npm", ["ci", "--prefix", join(target, ".github", "wikikb")]);
    assert.equal(dependencies.status, 0, dependencies.stderr || dependencies.stdout);
    const built = run("npm", ["run", "--prefix", join(target, ".github", "wikikb"), "build:wkb"]);
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const version = run(join(target, ".github", "wikikb", "tools", "wikikb-local", "wkb"), ["--version"]);
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.equal(version.stdout.trim(), "0.1.0");

    const installedWkb = join(target, ".github", "wikikb", "tools", "wikikb-local", "wkb");
    chmodSync(installedWkb, 0o644);
    const repeated = run(process.execPath, [
      "tools/install-agentic.js",
      "--target",
      target,
      "--confirm-private-repo",
      "--default-branch",
      "trunk",
    ]);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.match(repeated.stdout, /Written: 0; unchanged: \d+; modes repaired: 1/);
    assert.notEqual(statSync(installedWkb).mode & 0o111, 0);

    const changedWorkflow = join(target, ".github", "workflows", "search-kb.md");
    writeFileSync(changedWorkflow, `${readFileSync(changedWorkflow, "utf8")}\nlocal change\n`);
    const conflict = run(process.execPath, ["tools/install-agentic.js", "--target", target, "--confirm-private-repo", "--default-branch", "trunk"]);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /Refusing to overwrite 1 changed file/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("default-branch agentic install preserves compiled workflow integrity", () => {
  const target = mkdtempSync(join(tmpdir(), "wikikb-agentic-main-install-"));
  try {
    const initialized = run("git", ["init", "--initial-branch", "main", target]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const installed = run(process.execPath, [
      "tools/install-agentic.js",
      "--target",
      target,
      "--confirm-private-repo",
    ]);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    for (const workflow of ["compile-kb.md", "compile-kb.lock.yml", "sync-labels.yml"]) {
      assert.equal(
        readFileSync(join(target, ".github", "workflows", workflow), "utf8"),
        readFileSync(join(repoRoot, "tools", "agentic-install", "template", ".github", "workflows", workflow), "utf8"),
        `${workflow} changed during a default-branch install`,
      );
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("KB search helper refuses to run without a SOMA-backed target", () => {
  const missingTarget = run("bash", ["tools/kb-search.sh", "release"]);
  assert.equal(missingTarget.status, 1);
  assert.match(missingTarget.stderr, /WIKIKB_TARGET is required; no alternate search path exists/);

  for (const args of [
    ["tools/kb-search.sh", "release", "--top"],
    ["tools/kb-search.sh", "release", "--top", "0"],
    ["tools/kb-search.sh", "release", "--unknown"],
    ["tools/kb-search.sh", "release", "extra"],
  ]) {
    const invalid = run("bash", args);
    assert.equal(invalid.status, 2, `${args.join(" ")} should fail\n${invalid.stderr}`);
    assert.match(invalid.stderr, /Error:/);
  }
});

test("vendored SOMA manifest pins binary-only archives by checksum", () => {
  const vendorDir = join(repoRoot, "vendor", "soma");
  const manifest = JSON.parse(readFileSync(join(vendorDir, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "SOMA");
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.notices, "THIRD_PARTY_NOTICES.txt");
  assert.equal(manifest.model.repository, "minishlab/potion-retrieval-32M");
  assert.equal(manifest.model.revision, "6fc8051fab2a1e0ee76689cf08c853792ac285e7");
  assert.equal(manifest.model.license, "MIT");
  assert.equal(Object.keys(manifest.model.files).length, 7);
  for (const [file, digest] of Object.entries(manifest.model.files)) {
    assert.equal(file, file.split(/[\\/]/).at(-1));
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  assert.equal(manifest.artifacts.length, 5);
  const notices = join(vendorDir, manifest.notices);
  assert.equal(createHash("sha256").update(readFileSync(notices)).digest("hex"), manifest.notices_sha256);

  for (const artifact of manifest.artifacts) {
    assert.match(artifact.archive, /^soma-v0\.3\.0-/);
    assert.match(artifact.executable, /^soma(?:\.exe)?$/);
    assert.match(artifact.upstream_archive_sha256, /^[a-f0-9]{64}$/);
    const archive = join(vendorDir, artifact.archive);
    assert.ok(existsSync(archive), `${artifact.archive} is missing`);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    assert.equal(digest, artifact.archive_sha256, `${artifact.archive} checksum drifted`);
    const listed = artifact.format === "zip"
      ? run("unzip", ["-Z1", archive])
      : run("tar", ["-tzf", archive]);
    assert.equal(listed.status, 0, listed.stderr);
    const entries = listed.stdout.trim().split(/\r?\n/).filter((entry) => entry && entry !== "./" && entry !== ".");
    assert.deepEqual(entries.map((entry) => entry.replace(/^\.\//, "")), [artifact.executable]);
  }
});

test("native vendored SOMA executable reports version 0.3.0", () => {
  const vendorDir = join(repoRoot, "vendor", "soma");
  const manifest = JSON.parse(readFileSync(join(vendorDir, "manifest.json"), "utf8"));
  const artifact = manifest.artifacts.find((item) => item.platform === process.platform && item.arch === process.arch);
  if (!artifact) return;
  const extracted = mkdtempSync(join(tmpdir(), "wikikb-soma-version-"));
  const unpacked = run("tar", ["-xf", join(vendorDir, artifact.archive), "-C", extracted]);
  assert.equal(unpacked.status, 0, unpacked.stderr || unpacked.stdout);
  const version = run(join(extracted, artifact.executable), ["--version"]);
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.match(version.stdout.trim(), /0\.3\.0$/);
});

test("source installer builds a launcher backed by the vendored SOMA runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "wikikb-install-test-"));
  const installDir = join(home, "bin");
  const installed = run("bash", ["tools/wikikb-local/install.sh"], {
    env: {
      HOME: home,
      WKB_INSTALL_DIR: installDir,
    },
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /SOMA: vendored 0\.3\.0 binary available/);

  const launcher = join(installDir, "wkb");
  assert.ok(existsSync(launcher));
  const launcherBody = readFileSync(launcher, "utf8");
  assert.doesNotMatch(launcherBody, /SOMA_BINDINGS|SOMA_NATIVE/);
  assert.match(launcherBody, /tools\/wikikb-local\/wkb/);

  const version = run(launcher, ["--version"], { env: { HOME: home } });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.1.0");
});
