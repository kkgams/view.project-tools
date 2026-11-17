---
title: view.project-tools
status: reference
---

# view.project-tools

Issue, Markdown and properties Views for [GAMS](https://github.com/kkgams/gams), distributed as independently installable ZIPs. The local Project previews this README; issues use `issues/` and properties open as an internal popup. Markdown uses the Host renderer; properties require Host-owned `/widgets/inputs/<configured-module>.js` modules.

| View | Source → deployed file | Screenshot | Original work |
| --- | --- | --- | --- |
| view.issues (`view-issues`) | `src/view.issues/views/view-issues.js` → `views/view-issues.js` | Not available | GAMS authors |
| view.markdown (`view-markdow`) | `src/view.markdown/views/view-markdow.js` → `views/view-markdow.js` | Not available | GAMS authors |
| view.props (`view-props`) | `src/view.props/views/view-props.js` → `views/view-props.js` | Not available | GAMS authors |

## Development

Requires Make, Node.js, Python 3, curl, zip, unzip and tar. `make open` requires macOS Apple Silicon. Sources load directly; Host helpers and pinned released dependencies in `gams.json` are not bundled.

| Command | Purpose |
| --- | --- |
| `make open` | Open local Project in released Host; first launch needs network. |
| `make check` | Check JavaScript syntax. |
| `make test` | Check the local Issues configuration, source documents and descending sort. |
| `make package` | Build independent stable-name ZIPs and SHA256SUMS under `build.nosync/`. |
| `make serve-docs` | Preview pinned wiki; `DOCS_PORT=8081` overrides port 8080. |
| `make docs` | Build portable wiki in `build.nosync/site/`. |
| `make validate-docs` | Validate wiki links/content. |
| `make clean` | Remove all of `build.nosync/`, `tools/` and `gams_modules/`, without ownership markers; refuse tracked files or symlinks in deletion paths before deleting anything. |

Existing Host tools are never implicitly updated. Keep macOS security checks intact. GUI verification of issue persistence, Markdown rendering and dynamic property widgets remains pending.
