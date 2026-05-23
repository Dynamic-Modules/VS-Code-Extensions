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

The extension is intentionally a thin UI over the generated
`.dynamic_modules_build/index.json` file. For editor integration it also owns a
local, disposable authoring surface under `.dynamic_modules_authoring/`, where
it can materialize final files for normal VS Code search/edit/deconvert flows.
If the editor needs more structured module data, add it to the framework's
generated index instead of duplicating resolver or patch logic in JavaScript.

Run the lightweight validation checks from this repository root:

```bash
node --check extensions/dynamic-ss13-modules/extension.js
python3 -m json.tool extensions/dynamic-ss13-modules/package.json
```
