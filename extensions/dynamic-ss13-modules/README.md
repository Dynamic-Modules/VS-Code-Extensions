# Dynamic SS13 Modules

Maintainer tooling for SS13 repositories using Dynamic SS13 Modules.

The extension reads `.dynamic_modules_build/index.json`, shows enabled modules
in the Activity Bar, explains module interactions for the active file, decorates
patched or hooked lines, and can run the local prepare/workspace commands from
VS Code.

## Features

- Activity Bar container with:
  - a module/load-order tree
  - a current-file interaction tree
- status bar interaction count for the active editor
- inline line decorations for structured patches and local module source patches
- automatic live final files for materialized module edits, so normal editing
  and VS Code search operate on the post-module file contents
- clickable override boundary rows, changed-line highlighting, and removed-line
  callouts for files touched by modules
- hover snippets for hook source files and materialized patch output
- commands to run `prepare`, open generated files, and generate/open the
  multi-root module workspace
- commands to add a module root to the current VS Code workspace for quick edits
- generated-output and prepare-plugin views for Dynamic TGUI, Dynamic DM, and
  Dynamic Assets core-module outputs
- `Convert Changes to Module`, which turns selected branch or working-tree
  changes into a new module or appends them to an existing module
- authoring workspaces, which copy prepared final files into an editable folder
  and then deconvert those edits back into a module

## Convert Changes to Module

Run `Dynamic Modules: Convert Changes to Module` from a host repository branch.
The command asks for a base ref, shows the changed files, then asks whether to
create a new module or add to an existing module.

The converter is intentionally conservative:

- added `.dm` files are copied as module source or module tests
- added binary assets are copied under module assets and require `dynamic-assets`
- modified text and `.dm` files are converted only when they can become safe
  structured patches, such as an additive insertion or a single-line replace
- modified `tgui/` files are passed to Dynamic TGUI's `create-override` tool,
  which first tries to infer maintainable patch operations and only writes a
  whole-file override when it cannot safely reproduce the edit as a patch
- newly-added `tgui/` files are reported for manual wiring, since they usually
  need an explicit Dynamic TGUI manifest, import rewrite, or support-file layout
- deletions and complex hunks are reported in the Dynamic Modules output channel
  for a maintainer to convert by hand

For TGUI conversion, run `Dynamic Modules: Prepare` first when possible. The
extension prefers the generated `.dynamic_modules_build/tgui/cli.ts` wrapper and
falls back to the installed `dynamic-tgui/tools/cli.ts`. If Bun is not available
as `bun` in the VS Code extension host, set `dynamicSs13Modules.bunPath`.

The extension does not resolve modules by itself. Run `Dynamic Modules: Prepare`
after changing module manifests, local module patch manifests, or framework
configuration.

## Authoring Workspace

By default, opening a host file that has materialized Dynamic Modules output
opens a live final authoring copy under:

```text
.dynamic_modules_authoring/_live/files/
```

The folder remains inside the host repository, so opened final files are real
files and can be searched directly. The extension no longer adds that folder as
a second workspace root by default, because doing so turns a normal folder
window into an untitled multi-root workspace and can make external launchers
open a duplicate VS Code window. Enable
`dynamicSs13Modules.addLiveFinalFolderToWorkspace` only if you explicitly want
that multi-root workspace behavior. If an older live-authoring window is still
open as `Untitled (Workspace)`, the extension repairs it back to a normal folder
window automatically; you can also run `Dynamic Modules: Restore Folder Window`
from the command palette.

When a live final authoring file is active, the extension reveals the original
host file in VS Code Explorer by default. This keeps the Explorer oriented on
the normal repository path even though the editable buffer lives under
`.dynamic_modules_authoring/_live/files`.

The editor overlays mark changed regions with CodeLens rows and decorations:

- `MODULAR OVERRIDE FROM: <module>` at the start of a changed block
- red struck-through deleted source lines at the deleted position
- highlighted final lines inside the block
- `END MODULAR OVERRIDE: <module>` at the end of the block

Click any marker row to reveal the module and current-file interaction in the
Dynamic Modules sidebar. The marker rows are editor UI, not document text, so
they do not change line numbers or saved file contents.

Edit the `dynamic-final` files normally, then run
`Dynamic Modules: Deconvert Authoring Workspace` to convert those edits back
into a module. Disable this automatic behavior with
`dynamicSs13Modules.autoOpenFinalFiles` if you want to inspect untouched host
files directly.

Run `Dynamic Modules: Generate Authoring Workspace` from a prepared host repo.
The command runs prepare, lets you choose final files from the generated index,
then creates `.dynamic_modules_authoring/<session>/` with:

- `files/`: editable final files
- `baseline/`: the generated final files before your edits
- `dynamic-authoring.json`: session metadata, hashes, module interactions, and
  source paths
- `dynamic-authoring.code-workspace`: a two-folder workspace containing the host
  repo and the editable authoring files

After editing files under `files/`, run
`Dynamic Modules: Deconvert Authoring Workspace`. The extension compares the
edited files to the session baseline and writes a new module:

- `.dm` edits are passed to Dynamic DM's patch generator and verified against
  the baseline before output is accepted
- `tgui/` edits are passed to Dynamic TGUI's smart converter, which prefers AST
  patches and falls back to whole-file overrides when needed
- binary assets are copied into the module and marked as Dynamic Assets content
- unsupported text files are reported in the Dynamic Modules output channel for
  manual conversion

This flow is meant for maintainer/developer convenience. Run
`Dynamic Modules: Prepare` afterward to regenerate the final stack and inspect
the output before committing module changes.

## Local Validation

From the repository root:

```bash
node --check extensions/dynamic-ss13-modules/extension.js
python3 -m json.tool extensions/dynamic-ss13-modules/package.json
```
