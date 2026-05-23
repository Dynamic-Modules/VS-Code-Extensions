# Dynamic Modules VS Code Extensions

This repository contains VS Code extensions for the Dynamic Modules project.

## Extensions

- [Dynamic SS13 Modules](extensions/dynamic-ss13-modules): maintainer tooling
  for SS13 host repos using
  [Dynamic SS13 Modules](https://github.com/Dynamic-Modules/Dynamic-SS13-Modules).

The repository is laid out as a small extension monorepo so future Dynamic
Modules editor tooling can live beside the SS13 module maintainer extension
without forcing every package into one VS Code manifest.

## Local Development

Open `VS-Code-Extensions.code-workspace`, select the `Dynamic SS13 Modules:
Launch Extension` debug configuration, and press F5.

The extension itself is intentionally a thin UI over the generated
`.dynamic_modules_build/index.json` file. If the editor needs more structured
data, add it to the framework's generated index instead of duplicating resolver
or patch logic in JavaScript.
