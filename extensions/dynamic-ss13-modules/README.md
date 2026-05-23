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
- hover snippets for hook source files and materialized patch output
- commands to run `prepare`, open generated files, and generate/open the
  multi-root module workspace
- commands to add a module root to the current VS Code workspace for quick edits

The extension does not resolve modules by itself. Run `Dynamic Modules: Prepare`
after changing module manifests, local module patch manifests, or framework
configuration.
