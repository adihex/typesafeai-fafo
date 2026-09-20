# Vendored SOMA runtime

WikiKB ships SOMA 0.3.0, the Self-Organizing Memory for Agents CLI, as
binary-only platform archives. WikiKB uses SOMA as its indexing and retrieval
runtime. The runtime is mandatory for indexing
and retrieval; no source checkout, runtime download, or alternate retrieval
path is included.

`manifest.json` is authoritative for platform selection and SHA-256
verification. WikiKB verifies the archive and executable before extracting the
runtime into the user's private cache. `WIKIKB_SOMA_BIN` can select an approved,
operator-managed executable for controlled testing and deployment.

The macOS arm64, Linux x64/arm64, and Windows x64/arm64 packages contain
unchanged executable bytes from the SOMA team's authorized binary release.
WikiKB packages the executable as `soma` or `soma.exe` for runtime-path
compatibility and wraps it in a checksum-pinned archive.
The manifest also pins the original release archive digest. No private
source-repository locator or executable network fetch is part of the release.

Microsoft has authorized the WikiKB maintainer to redistribute these unchanged
compiled SOMA binaries with WikiKB. The executable remains a separately
licensed component: WikiKB's MIT license does not grant source, modification,
or relicensing rights for SOMA. Runtime source is not included. The licensing
boundary is recorded in `THIRD_PARTY_NOTICES.txt`.

Version 0.3.0 requires a public MIT-licensed static retrieval model. The manifest
pins its public repository revision and all seven file digests. On first query,
the vendored executable installs the model and WikiKB verifies every file. A
preinstalled model selected with `WIKIKB_SOMA_MODEL_DIR` is verified identically.
