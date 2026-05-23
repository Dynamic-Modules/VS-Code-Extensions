const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const CONFIG_SECTION = "dynamicSs13Modules";
const OUTPUT_NAME = "Dynamic Modules";
const DEFAULT_INDEX_PATH = ".dynamic_modules_build/index.json";

function activate(context) {
  const controller = new DynamicModulesController(context);
  context.subscriptions.push(controller);
}

function deactivate() {}

class DynamicModulesController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel(OUTPUT_NAME);
    this.modulesProvider = new ModulesProvider(this);
    this.currentFileProvider = new CurrentFileProvider(this);
    this.codeLensProvider = new InteractionCodeLensProvider(this);
    this.hoverProvider = new InteractionHoverProvider(this);
    this.watchers = [];
    this.index = null;
    this.indexPath = null;
    this.root = null;
    this.commandRunning = false;

    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.warningForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground")
    });

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 75);
    this.statusBar.command = "dynamicSs13Modules.explainCurrentFile";

    context.subscriptions.push(
      this.output,
      this.decorationType,
      this.statusBar,
      vscode.window.registerTreeDataProvider("dynamicSs13Modules.modules", this.modulesProvider),
      vscode.window.registerTreeDataProvider("dynamicSs13Modules.currentFile", this.currentFileProvider),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this.codeLensProvider),
      vscode.languages.registerHoverProvider({ scheme: "file" }, this.hoverProvider),
      vscode.commands.registerCommand("dynamicSs13Modules.refresh", () => this.refresh(true)),
      vscode.commands.registerCommand("dynamicSs13Modules.prepare", () => this.prepare()),
      vscode.commands.registerCommand("dynamicSs13Modules.generateWorkspace", () => this.generateWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.openWorkspace", () => this.openGeneratedWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.explainCurrentFile", () => this.explainCurrentFile()),
      vscode.commands.registerCommand("dynamicSs13Modules.previewCurrentFile", () => this.previewCurrentFile()),
      vscode.commands.registerCommand("dynamicSs13Modules.openIndex", () => this.openIndex()),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedInclude", () => this.openGeneratedFile("include_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedTests", () => this.openGeneratedFile("tests_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedConfig", () => this.openGeneratedFile("config_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openModuleManifest", (item) => this.openModuleManifest(item)),
      vscode.commands.registerCommand("dynamicSs13Modules.addModuleRootToWorkspace", (item) => this.addModuleRootToWorkspace(item)),
      vscode.commands.registerCommand("dynamicSs13Modules.copyInteractionSummary", (item) => this.copyInteractionSummary(item)),
      vscode.commands.registerCommand("dynamicSs13Modules.openSettings", () => this.openSettings()),
      vscode.commands.registerCommand("dynamicSs13Modules.openPath", (target) => this.openPath(target)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveFileState()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document.uri.toString() === editor.document.uri.toString()) {
          this.updateActiveFileState();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          this.refresh(false);
          this.configureWatchers();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.refresh(false);
        this.configureWatchers();
      })
    );

    this.refresh(false);
    this.configureWatchers();
  }

  dispose() {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  config() {
    const rootUri = this.root ? vscode.Uri.file(this.root) : undefined;
    return vscode.workspace.getConfiguration(CONFIG_SECTION, rootUri);
  }

  refresh(showMessage) {
    this.root = this.findWorkspaceRoot();
    this.indexPath = this.root ? this.resolveConfiguredIndexPath(this.root) : null;
    this.index = this.readIndex(showMessage);
    this.modulesProvider.refresh();
    this.currentFileProvider.refresh();
    this.codeLensProvider.refresh();
    this.updateActiveFileState();

    if (showMessage) {
      if (this.index) {
        vscode.window.showInformationMessage(`Dynamic Modules index loaded: ${this.describeIndexTime()}`);
      } else if (this.indexPath) {
        vscode.window.showWarningMessage(`No Dynamic Modules index found at ${this.indexPath}.`);
      } else {
        vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      }
    }
  }

  configureWatchers() {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    if (!this.root) {
      return;
    }

    const patterns = [
      this.relativeIndexPattern(),
      "dynamic_modules.toml",
      "dynamic_modules/**/*.module.toml",
      "config/dynamic_modules/**/*.toml"
    ].filter(Boolean);

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, pattern));
      const refresh = () => {
        if (this.config().get("autoRefresh", true)) {
          this.refresh(false);
        }
      };
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      this.watchers.push(watcher);
    }
  }

  relativeIndexPattern() {
    const configured = this.config().get("indexPath", DEFAULT_INDEX_PATH) || DEFAULT_INDEX_PATH;
    if (isLikelyAbsolute(configured)) {
      return null;
    }
    return configured.replace(/\\/g, "/");
  }

  readIndex(showMessage) {
    if (!this.indexPath || !fs.existsSync(this.indexPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
    } catch (error) {
      if (showMessage) {
        vscode.window.showWarningMessage(`Could not read Dynamic Modules index: ${error.message}`);
      }
      this.output.appendLine(`Could not read ${this.indexPath}: ${error.stack || error.message}`);
      return null;
    }
  }

  findWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      return null;
    }

    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activePath) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activePath));
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    for (const folder of folders) {
      const root = folder.uri.fsPath;
      const indexPath = this.resolveConfiguredIndexPath(root);
      if (indexPath && fs.existsSync(indexPath)) {
        return root;
      }
    }

    for (const folder of folders) {
      const root = folder.uri.fsPath;
      if (fs.existsSync(path.join(root, "dynamic_modules.toml"))) {
        return root;
      }
    }

    return folders[0].uri.fsPath;
  }

  resolveConfiguredIndexPath(root) {
    const configured = this.config().get("indexPath", DEFAULT_INDEX_PATH) || DEFAULT_INDEX_PATH;
    return this.resolvePath(configured, root);
  }

  localHostRoot() {
    if (!this.index?.host_root) {
      return this.root;
    }
    return localizeAbsolutePath(this.index.host_root) || this.root;
  }

  resolvePath(value, baseRoot) {
    if (!value) {
      return null;
    }
    if (isLikelyAbsolute(value)) {
      return localizeAbsolutePath(value);
    }
    const root = baseRoot || this.localHostRoot() || this.root;
    return root ? path.resolve(root, value) : value;
  }

  resolveIndexPath(value) {
    return this.resolvePath(value, this.localHostRoot());
  }

  resolveBuildOutputPath(value) {
    if (!value) {
      return null;
    }
    if (isLikelyAbsolute(value)) {
      return localizeAbsolutePath(value);
    }
    const buildDir = this.resolveIndexPath(this.index?.build_dir || ".dynamic_modules_build");
    return buildDir ? path.resolve(buildDir, value) : null;
  }

  keyForDocument(document) {
    if (!this.index) {
      return null;
    }
    const fileComparable = comparablePath(document.uri.fsPath);
    const hostComparable = comparablePath(this.index.host_root || this.root || "");
    if (hostComparable && startsWithPath(fileComparable, hostComparable)) {
      return stripLeadingSlash(fileComparable.slice(hostComparable.length)).replace(/\\/g, "/");
    }

    const localRoot = this.localHostRoot();
    if (localRoot) {
      const localComparable = comparablePath(localRoot);
      if (startsWithPath(fileComparable, localComparable)) {
        return stripLeadingSlash(fileComparable.slice(localComparable.length)).replace(/\\/g, "/");
      }
    }

    const workspaceRoot = this.root;
    if (workspaceRoot) {
      const workspaceComparable = comparablePath(workspaceRoot);
      if (startsWithPath(fileComparable, workspaceComparable)) {
        return stripLeadingSlash(fileComparable.slice(workspaceComparable.length)).replace(/\\/g, "/");
      }
    }

    return document.uri.fsPath.replace(/\\/g, "/");
  }

  interactionsForDocument(document) {
    if (!this.index || !document || document.uri.scheme !== "file") {
      return [];
    }
    const key = this.keyForDocument(document);
    if (!key) {
      return [];
    }
    const files = this.index.files || {};
    if (files[key]) {
      return files[key];
    }
    const keyComparable = comparablePath(key);
    const match = Object.keys(files).find((candidate) => comparablePath(candidate) === keyComparable);
    return match ? files[match] : [];
  }

  describeIndexTime() {
    if (!this.index?.generated_at) {
      return "generated index";
    }
    return `generated ${this.index.generated_at}`;
  }

  updateActiveFileState() {
    this.currentFileProvider.refresh();
    this.updateStatusBar();
    this.updateDecorations();
  }

  updateStatusBar() {
    if (!this.config().get("showStatusBar", true)) {
      this.statusBar.hide();
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      this.statusBar.text = "$(plug) Dynamic Modules";
      this.statusBar.tooltip = "Open a file to see Dynamic Modules interactions.";
      this.statusBar.show();
      return;
    }

    const interactions = this.interactionsForDocument(editor.document);
    this.statusBar.text = interactions.length
      ? `$(plug) Dynamic Modules: ${interactions.length}`
      : "$(plug) Dynamic Modules";
    this.statusBar.tooltip = interactions.length
      ? `${interactions.length} interaction${interactions.length === 1 ? "" : "s"} for this file`
      : "No interactions recorded for this file.";
    this.statusBar.show();
  }

  updateDecorations() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!this.config().get("showDecorations", true)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const interactions = this.interactionsForDocument(editor.document);
    const decorations = [];
    for (const interaction of interactions) {
      const lineNumber = Number(interaction.anchor_line);
      if (!Number.isInteger(lineNumber)) {
        continue;
      }
      const line = Math.max(0, Math.min(editor.document.lineCount - 1, lineNumber - 1));
      const lineText = editor.document.lineAt(line);
      const label = `  Dynamic: ${this.shortInteractionLabel(interaction)}`;
      decorations.push({
        range: new vscode.Range(line, lineText.range.end.character, line, lineText.range.end.character),
        hoverMessage: this.markdownForInteraction(interaction),
        renderOptions: {
          after: {
            contentText: label,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic",
            margin: "0 0 0 1.5em"
          }
        }
      });
    }
    editor.setDecorations(this.decorationType, decorations);
  }

  shortInteractionLabel(interaction) {
    const kind = interaction.kind === "module_patch" ? "local patch" : interaction.kind;
    return `${kind} ${interaction.module || "unknown"}:${interaction.id || "unknown"}`;
  }

  markdownForInteraction(interaction) {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = false;
    markdown.supportHtml = false;
    markdown.appendMarkdown(`**${this.shortInteractionLabel(interaction)}**\n\n`);
    for (const line of this.interactionSummaryLines(interaction)) {
      markdown.appendMarkdown(`${escapeMarkdown(line)}\n\n`);
    }

    const snippet = this.snippetForInteraction(interaction);
    if (snippet) {
      markdown.appendMarkdown(`_${escapeMarkdown(snippet.title)}_\n\n`);
      markdown.appendCodeblock(snippet.text, "dm");
    }
    return markdown;
  }

  interactionSummaryLines(interaction) {
    const lines = [];
    if (interaction.target_file) {
      lines.push(`Target: ${interaction.target_file}`);
    }
    if (interaction.target) {
      lines.push(`Target: ${interaction.target}`);
    }
    if (interaction.mode) {
      lines.push(`Mode: ${interaction.mode}`);
    }
    if (interaction.anchor_line) {
      lines.push(`Anchor line: ${interaction.anchor_line}`);
    }
    if (interaction.risk) {
      lines.push(`Risk: ${interaction.risk}`);
    }
    if (interaction.output_file) {
      lines.push(`Materialized output: ${interaction.output_file}`);
    }
    if (interaction.source_file) {
      lines.push(`Source: ${interaction.source_file}`);
    }
    if (interaction.description) {
      lines.push(`Description: ${interaction.description}`);
    }
    return lines;
  }

  snippetForInteraction(interaction) {
    if (!this.index) {
      return null;
    }

    if (interaction.kind === "hook" && interaction.source_file) {
      const module = this.index.modules?.[interaction.module];
      const sourcePath = module?.root
        ? this.resolveIndexPath(posixJoin(module.root, interaction.source_file))
        : this.resolveIndexPath(interaction.source_file);
      const text = readFileSnippet(sourcePath, 1, 80);
      if (text) {
        return { title: `Hook source: ${interaction.source_file}`, text };
      }
    }

    if ((interaction.kind === "patch" || interaction.kind === "module_patch") && interaction.output_file) {
      const outputPath = this.resolveBuildOutputPath(interaction.output_file);
      const contextLines = this.config().get("snippetContextLines", 4);
      const anchor = Number(interaction.anchor_line) || 1;
      const text = readFileSnippet(outputPath, anchor, contextLines);
      if (text) {
        return { title: `Materialized output: ${interaction.output_file}`, text };
      }
    }

    return null;
  }

  openIndex() {
    if (!this.indexPath || !fs.existsSync(this.indexPath)) {
      vscode.window.showWarningMessage("No Dynamic Modules index found. Run Dynamic Modules: Prepare.");
      return;
    }
    return this.openPath(this.indexPath);
  }

  openGeneratedFile(key) {
    const generated = this.index?.generated || {};
    const value = generated[key];
    if (!value) {
      vscode.window.showWarningMessage("The generated index does not contain that output path.");
      return;
    }
    return this.openPath(this.resolveIndexPath(value));
  }

  async openModuleManifest(item) {
    const moduleId = moduleIdFromItem(item);
    const module = moduleId ? this.index?.modules?.[moduleId] : null;
    if (!module?.manifest) {
      vscode.window.showWarningMessage("No module manifest path is available for that item.");
      return;
    }
    await this.openPath(this.resolveIndexPath(module.manifest));
  }

  async addModuleRootToWorkspace(item) {
    const moduleId = moduleIdFromItem(item);
    const module = moduleId ? this.index?.modules?.[moduleId] : null;
    if (!module?.root) {
      vscode.window.showWarningMessage("No module root is available for that item.");
      return;
    }
    const moduleRoot = this.resolveIndexPath(module.root);
    if (!moduleRoot || !fs.existsSync(moduleRoot)) {
      vscode.window.showWarningMessage(`Module root does not exist: ${moduleRoot || module.root}`);
      return;
    }

    const uri = vscode.Uri.file(moduleRoot);
    const folders = vscode.workspace.workspaceFolders || [];
    const alreadyOpen = folders.some((folder) => comparablePath(folder.uri.fsPath) === comparablePath(moduleRoot));
    if (alreadyOpen) {
      vscode.window.showInformationMessage(`${moduleId} is already in the workspace.`);
      return;
    }

    const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri,
      name: `module:${moduleId}`
    });
    if (!added) {
      vscode.window.showWarningMessage(`Could not add ${moduleId} to the workspace.`);
    }
  }

  async copyInteractionSummary(item) {
    const interaction = interactionFromItem(item);
    if (!interaction) {
      await this.explainCurrentFile({ copyOnly: true });
      return;
    }
    await vscode.env.clipboard.writeText(this.formatInteraction(interaction));
    vscode.window.showInformationMessage("Copied Dynamic Modules interaction summary.");
  }

  async previewCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file first.");
      return;
    }
    const interactions = this.interactionsForDocument(editor.document)
      .filter((item) => (item.kind === "patch" || item.kind === "module_patch") && item.output_file);
    if (!interactions.length) {
      vscode.window.showInformationMessage("No materialized patch output is recorded for this file.");
      return;
    }

    const selected = interactions.length === 1
      ? interactions[0]
      : await vscode.window.showQuickPick(interactions.map((interaction) => ({
        label: this.shortInteractionLabel(interaction),
        description: interaction.output_file,
        interaction
      })), { placeHolder: "Choose materialized output to open" }).then((pick) => pick?.interaction);

    if (selected) {
      await this.openPath(this.resolveBuildOutputPath(selected.output_file));
    }
  }

  async explainCurrentFile(options = {}) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file first.");
      return;
    }
    const interactions = this.interactionsForDocument(editor.document);
    const key = this.keyForDocument(editor.document) || editor.document.uri.fsPath;
    const lines = [];
    if (!interactions.length) {
      lines.push(`No Dynamic Modules interactions recorded for ${key}.`);
    } else {
      lines.push(`Dynamic Modules interactions for ${key}:`);
      for (const interaction of interactions) {
        lines.push("");
        lines.push(this.formatInteraction(interaction));
      }
    }

    const text = lines.join("\n");
    if (options.copyOnly) {
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Copied Dynamic Modules interaction summary.");
      return;
    }

    this.output.clear();
    this.output.appendLine(text);
    this.output.show(true);
  }

  formatInteraction(interaction) {
    const lines = [`- ${this.shortInteractionLabel(interaction)}`];
    for (const line of this.interactionSummaryLines(interaction)) {
      lines.push(`  ${line}`);
    }
    return lines.join("\n");
  }

  async openPath(target) {
    const targetPath = typeof target === "string" ? target : target?.path;
    if (!targetPath) {
      return;
    }
    const resolved = this.resolvePath(targetPath, this.localHostRoot()) || targetPath;
    if (!fs.existsSync(resolved)) {
      vscode.window.showWarningMessage(`Path does not exist: ${resolved}`);
      return;
    }
    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(resolved));
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(document);
  }

  prepare() {
    const custom = this.config().get("prepareCommand", "");
    if (custom && custom.trim()) {
      return this.runShellCommand(custom, "Prepare");
    }
    return this.runFrameworkCommand("prepare", "Prepare");
  }

  async generateWorkspace() {
    const result = await this.runFrameworkCommand("workspace-generate", "Generate Module Workspace");
    if (result === 0) {
      const answer = await vscode.window.showInformationMessage(
        "Dynamic Modules workspace generated.",
        "Open Workspace"
      );
      if (answer === "Open Workspace") {
        await this.openGeneratedWorkspace();
      }
    }
  }

  async openGeneratedWorkspace() {
    if (!this.root) {
      vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      return;
    }
    const workspacePath = path.join(this.root, ".dynamic_modules_build", "dynamic-modules.code-workspace");
    if (!fs.existsSync(workspacePath)) {
      vscode.window.showWarningMessage("No generated module workspace found. Run Dynamic Modules: Generate Module Workspace.");
      return;
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspacePath), {
      forceNewWindow: false
    });
  }

  runFrameworkCommand(subcommand, title) {
    if (!this.root) {
      vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      return Promise.resolve(1);
    }

    const pythonPath = this.config().get("pythonPath", "python3") || "python3";
    const prepareScript = this.config().get("prepareScript", "tools/dynamic_modules/prepare.py") || "tools/dynamic_modules/prepare.py";
    const prepareScriptPath = this.resolvePath(prepareScript, this.root);
    const frameworkRoot = path.join(this.root, "dynamic_modules", "framework");

    if (subcommand === "prepare" && prepareScriptPath && fs.existsSync(prepareScriptPath)) {
      return this.execFile(pythonPath, [prepareScriptPath], this.root, title);
    }

    if (fs.existsSync(path.join(frameworkRoot, "dynamic_ss13_modules"))) {
      return this.execFile(
        pythonPath,
        ["-m", "dynamic_ss13_modules", "--root", this.root, subcommand],
        frameworkRoot,
        title
      );
    }

    return this.execFile("dynamic-modules", ["--root", this.root, subcommand], this.root, title);
  }

  runShellCommand(command, title) {
    if (!this.root) {
      vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      return Promise.resolve(1);
    }
    return this.withProgress(title, () => new Promise((resolve) => {
      this.commandRunning = true;
      this.output.show(true);
      this.output.appendLine(`$ ${command}`);
      childProcess.exec(command, {
        cwd: this.root,
        maxBuffer: 1024 * 1024 * 20,
        windowsHide: true
      }, (error, stdout, stderr) => {
        this.appendCommandOutput(stdout, stderr);
        this.commandRunning = false;
        const code = error?.code || 0;
        this.finishCommand(title, code);
        resolve(code);
      });
    }));
  }

  execFile(file, args, cwd, title) {
    return this.withProgress(title, () => new Promise((resolve) => {
      this.commandRunning = true;
      this.output.show(true);
      this.output.appendLine(`$ ${file} ${args.map(shellishQuote).join(" ")}`);
      childProcess.execFile(file, args, {
        cwd,
        maxBuffer: 1024 * 1024 * 20,
        windowsHide: true
      }, (error, stdout, stderr) => {
        this.appendCommandOutput(stdout, stderr);
        this.commandRunning = false;
        const code = error?.code || 0;
        this.finishCommand(title, code);
        resolve(code);
      });
    }));
  }

  withProgress(title, task) {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Dynamic Modules: ${title}`,
      cancellable: false
    }, task);
  }

  appendCommandOutput(stdout, stderr) {
    if (stdout) {
      this.output.append(stdout);
      if (!stdout.endsWith("\n")) {
        this.output.appendLine("");
      }
    }
    if (stderr) {
      this.output.append(stderr);
      if (!stderr.endsWith("\n")) {
        this.output.appendLine("");
      }
    }
  }

  finishCommand(title, code) {
    if (code === 0) {
      this.output.appendLine(`Dynamic Modules: ${title} completed.`);
      this.refresh(false);
      vscode.window.showInformationMessage(`Dynamic Modules: ${title} completed.`);
      return;
    }
    this.output.appendLine(`Dynamic Modules: ${title} failed with exit code ${code}.`);
    vscode.window.showErrorMessage(`Dynamic Modules: ${title} failed. See the Dynamic Modules output channel.`);
  }

  openSettings() {
    vscode.commands.executeCommand("workbench.action.openSettings", `@ext:dynamic-modules.dynamic-ss13-modules`);
  }
}

class ModulesProvider {
  constructor(controller) {
    this.controller = controller;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    const index = this.controller.index;
    if (!index) {
      return [
        infoItem("No generated index", "Run Dynamic Modules: Prepare from a host repo."),
        commandItem("Prepare", "dynamicSs13Modules.prepare", "$(run)")
      ];
    }

    if (!element) {
      const modules = index.modules || {};
      const items = (index.load_order || []).map((moduleId, offset) => moduleItem(moduleId, modules[moduleId] || {}, offset));
      if (index.warnings?.length) {
        items.unshift(groupItem("Warnings", "warnings", index.warnings.length));
      }
      return items;
    }

    if (element.type === "warnings") {
      return (index.warnings || []).map((warning) => infoItem(warning));
    }

    if (element.type === "module") {
      return this.moduleChildren(element.moduleId, element.moduleData);
    }

    if (element.type === "group") {
      return this.groupChildren(element);
    }

    return [];
  }

  moduleChildren(moduleId, moduleData) {
    const children = [];
    children.push(detailItem("Version", moduleData.version || "unknown"));
    children.push(detailItem("Module API", moduleData.module_api || "unknown"));
    if (moduleData.source?.repo) {
      children.push(detailItem("Repository", moduleData.source.repo));
    }
    if (moduleData.root) {
      children.push(pathItem("Root", moduleData.root, "dynamicSs13Modules.addModuleRootToWorkspace", { moduleId }));
    }
    if (moduleData.manifest) {
      children.push(pathItem("Manifest", moduleData.manifest, "dynamicSs13Modules.openModuleManifest", { moduleId }));
    }

    const lockModule = this.controller.index?.lockfile_preview?.modules?.[moduleId];
    if (lockModule?.commit) {
      children.push(detailItem("Commit", lockModule.commit));
    }
    if (lockModule?.dependencies?.length) {
      children.push(groupItem("Dependencies", "dependencies", lockModule.dependencies.length, { moduleId }));
    }
    if (moduleData.dm_files?.length) {
      children.push(groupItem("DM files", "dmFiles", moduleData.dm_files.length, { moduleId }));
    }
    if (moduleData.test_files?.length) {
      children.push(groupItem("Tests", "testFiles", moduleData.test_files.length, { moduleId }));
    }
    if (moduleData.hooks?.length) {
      children.push(groupItem("Hooks", "hooks", moduleData.hooks.length, { moduleId }));
    }
    if (moduleData.patches?.length) {
      children.push(groupItem("Structured patches", "patches", moduleData.patches.length, { moduleId }));
    }
    if (moduleData.local_module_patches?.length) {
      children.push(groupItem("Local module patches", "localPatches", moduleData.local_module_patches.length, { moduleId }));
    }
    return children;
  }

  groupChildren(group) {
    const moduleData = this.controller.index?.modules?.[group.moduleId] || {};
    if (group.groupKind === "dependencies") {
      const deps = this.controller.index?.lockfile_preview?.modules?.[group.moduleId]?.dependencies || [];
      return deps.map((dependency) => detailItem(dependency, "required"));
    }
    if (group.groupKind === "dmFiles") {
      return (moduleData.dm_files || []).map((filePath) => fileItem(filePath, this.controller.resolveIndexPath(filePath)));
    }
    if (group.groupKind === "testFiles") {
      return (moduleData.test_files || []).map((filePath) => fileItem(filePath, this.controller.resolveIndexPath(filePath), "$(beaker)"));
    }
    if (group.groupKind === "hooks") {
      return (moduleData.hooks || []).map((hook) => interactionTreeItem({
        kind: "hook",
        module: group.moduleId,
        id: hook.id,
        target: hook.target,
        target_file: hook.target_file,
        mode: hook.mode,
        source_file: hook.file,
        description: hook.description
      }));
    }
    if (group.groupKind === "patches") {
      return (moduleData.patches || []).map((patch) => interactionTreeItem({
        kind: "patch",
        module: group.moduleId,
        id: patch.id,
        target_file: patch.target_file,
        mode: patch.mode,
        anchor: patch.anchor,
        source_file: patch.file,
        risk: patch.risk
      }));
    }
    if (group.groupKind === "localPatches") {
      return (moduleData.local_module_patches || []).map((patch) => interactionTreeItem({
        kind: "module_patch",
        module: group.moduleId,
        id: patch.patch_id,
        target_file: patch.target_file,
        mode: patch.mode,
        anchor: patch.anchor,
        anchor_line: patch.anchor_line,
        output_file: patch.output_file,
        risk: patch.risk
      }));
    }
    return [];
  }
}

class CurrentFileProvider {
  constructor(controller) {
    this.controller = controller;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return [infoItem("No active file", "Open a DM file to see module interactions.")];
    }
    const interactions = this.controller.interactionsForDocument(editor.document);
    if (!interactions.length) {
      return [infoItem("No interactions", "No generated index entries target this file.")];
    }
    if (!element) {
      return interactions.map((interaction) => interactionTreeItem(interaction));
    }
    if (element.type === "interaction") {
      return this.interactionChildren(element.interaction);
    }
    return [];
  }

  interactionChildren(interaction) {
    const children = [];
    for (const line of this.controller.interactionSummaryLines(interaction)) {
      const [label, ...rest] = line.split(": ");
      children.push(detailItem(label, rest.join(": ")));
    }
    if (interaction.output_file) {
      children.push(pathItem("Open materialized output", interaction.output_file, "dynamicSs13Modules.openPath", {
        path: this.controller.resolveBuildOutputPath(interaction.output_file)
      }));
    }
    if (interaction.source_file && interaction.module) {
      const module = this.controller.index?.modules?.[interaction.module];
      const sourcePath = module?.root
        ? this.controller.resolveIndexPath(posixJoin(module.root, interaction.source_file))
        : this.controller.resolveIndexPath(interaction.source_file);
      children.push(pathItem("Open source", interaction.source_file, "dynamicSs13Modules.openPath", { path: sourcePath }));
    }
    return children;
  }
}

class InteractionCodeLensProvider {
  constructor(controller) {
    this.controller = controller;
    this._onDidChangeCodeLenses = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  }

  refresh() {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document) {
    const interactions = this.controller.interactionsForDocument(document);
    if (!interactions.length) {
      return [];
    }

    const lenses = [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: `Dynamic Modules: ${interactions.length} interaction${interactions.length === 1 ? "" : "s"}`,
        command: "dynamicSs13Modules.explainCurrentFile"
      })
    ];

    for (const interaction of interactions) {
      const lineNumber = Number(interaction.anchor_line);
      if (!Number.isInteger(lineNumber)) {
        continue;
      }
      const line = Math.max(0, Math.min(document.lineCount - 1, lineNumber - 1));
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: this.controller.shortInteractionLabel(interaction),
        command: "dynamicSs13Modules.explainCurrentFile"
      }));
    }
    return lenses;
  }
}

class InteractionHoverProvider {
  constructor(controller) {
    this.controller = controller;
  }

  provideHover(document, position) {
    const interactions = this.controller.interactionsForDocument(document);
    if (!interactions.length) {
      return undefined;
    }
    const onLine = interactions.filter((interaction) => Number(interaction.anchor_line) === position.line + 1);
    if (!onLine.length) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = false;
    for (const interaction of onLine) {
      markdown.appendMarkdown(`**${escapeMarkdown(this.controller.shortInteractionLabel(interaction))}**\n\n`);
      for (const line of this.controller.interactionSummaryLines(interaction)) {
        markdown.appendMarkdown(`${escapeMarkdown(line)}\n\n`);
      }
      const snippet = this.controller.snippetForInteraction(interaction);
      if (snippet) {
        markdown.appendMarkdown(`_${escapeMarkdown(snippet.title)}_\n\n`);
        markdown.appendCodeblock(snippet.text, "dm");
      }
    }
    return new vscode.Hover(markdown);
  }
}

function moduleItem(moduleId, moduleData, offset) {
  const item = new vscode.TreeItem(`${offset + 1}. ${moduleId}`, vscode.TreeItemCollapsibleState.Collapsed);
  item.type = "module";
  item.moduleId = moduleId;
  item.moduleData = moduleData;
  item.contextValue = "module";
  item.description = moduleData.version || "";
  item.tooltip = [
    moduleData.name || moduleId,
    moduleData.root || "",
    moduleData.source?.repo || ""
  ].filter(Boolean).join("\n");
  item.iconPath = new vscode.ThemeIcon("package");
  return item;
}

function groupItem(label, groupKind, count, extra = {}) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.type = groupKind === "warnings" ? "warnings" : "group";
  item.groupKind = groupKind;
  item.moduleId = extra.moduleId;
  item.description = String(count);
  item.iconPath = groupIcon(groupKind);
  return item;
}

function detailItem(label, description = "") {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  item.tooltip = description ? `${label}: ${description}` : label;
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

function infoItem(label, description = "") {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = description;
  item.tooltip = description || label;
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

function commandItem(label, command, icon) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.command = { command, title: label };
  item.iconPath = new vscode.ThemeIcon(icon.replace("$(", "").replace(")", ""));
  return item;
}

function pathItem(label, displayPath, command, args) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = displayPath;
  item.tooltip = displayPath;
  item.command = { command, title: label, arguments: [args] };
  item.iconPath = new vscode.ThemeIcon("file");
  return item;
}

function fileItem(displayPath, resolvedPath, icon = "$(file-code)") {
  const item = new vscode.TreeItem(path.basename(displayPath), vscode.TreeItemCollapsibleState.None);
  item.description = displayPath;
  item.tooltip = resolvedPath || displayPath;
  item.command = { command: "dynamicSs13Modules.openPath", title: "Open File", arguments: [{ path: resolvedPath || displayPath }] };
  item.iconPath = new vscode.ThemeIcon(icon.replace("$(", "").replace(")", ""));
  if (resolvedPath) {
    item.resourceUri = vscode.Uri.file(resolvedPath);
  }
  return item;
}

function interactionTreeItem(interaction) {
  const kind = interaction.kind === "module_patch" ? "local patch" : interaction.kind;
  const label = `${kind} ${interaction.module || "unknown"}:${interaction.id || "unknown"}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.type = "interaction";
  item.interaction = interaction;
  item.contextValue = "interaction";
  item.description = interaction.anchor_line ? `line ${interaction.anchor_line}` : interaction.mode || "";
  item.tooltip = [
    label,
    interaction.target_file || interaction.target || "",
    interaction.output_file || interaction.source_file || ""
  ].filter(Boolean).join("\n");
  item.iconPath = interactionIcon(interaction.kind);
  return item;
}

function groupIcon(kind) {
  const icons = {
    dependencies: "references",
    dmFiles: "file-code",
    testFiles: "beaker",
    hooks: "plug",
    patches: "diff-added",
    localPatches: "diff-modified",
    warnings: "warning"
  };
  return new vscode.ThemeIcon(icons[kind] || "folder");
}

function interactionIcon(kind) {
  const icons = {
    hook: "plug",
    patch: "diff-added",
    module_patch: "diff-modified"
  };
  return new vscode.ThemeIcon(icons[kind] || "symbol-event");
}

function moduleIdFromItem(item) {
  if (!item) {
    return null;
  }
  if (typeof item === "string") {
    return item;
  }
  return item.moduleId || item.interaction?.module || null;
}

function interactionFromItem(item) {
  return item?.interaction || null;
}

function readFileSnippet(filePath, anchorLine, contextLines) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    let start;
    let end;
    if (contextLines > 20) {
      start = 0;
      end = Math.min(lines.length, contextLines);
    } else {
      start = Math.max(0, anchorLine - contextLines - 1);
      end = Math.min(lines.length, anchorLine + contextLines);
    }
    const width = String(end).length;
    return lines.slice(start, end)
      .map((line, index) => `${String(start + index + 1).padStart(width, " ")} | ${line}`)
      .join("\n");
  } catch {
    return null;
  }
}

function isLikelyAbsolute(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

function localizeAbsolutePath(value) {
  if (!value) {
    return value;
  }
  const normalized = value.replace(/\\/g, "/");
  const variants = [value];
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
  if (wslMatch) {
    variants.push(`${wslMatch[1].toUpperCase()}:\\${wslMatch[2].replace(/\//g, "\\")}`);
  }
  const winMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (winMatch) {
    variants.push(`/mnt/${winMatch[1].toLowerCase()}/${winMatch[2]}`);
  }
  for (const variant of variants) {
    if (fs.existsSync(variant)) {
      return variant;
    }
  }
  if (process.platform === "win32" && wslMatch) {
    return `${wslMatch[1].toUpperCase()}:\\${wslMatch[2].replace(/\//g, "\\")}`;
  }
  if (process.platform !== "win32" && winMatch) {
    return `/mnt/${winMatch[1].toLowerCase()}/${winMatch[2]}`;
  }
  return value;
}

function comparablePath(value) {
  if (!value) {
    return "";
  }
  let normalized = value.replace(/\\/g, "/");
  const winMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (winMatch) {
    normalized = `/mnt/${winMatch[1].toLowerCase()}/${winMatch[2]}`;
  }
  normalized = normalized.replace(/\/+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function startsWithPath(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function stripLeadingSlash(value) {
  return value.replace(/^\/+/, "");
}

function posixJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function shellishQuote(value) {
  if (!/[\s"'$]/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

module.exports = { activate, deactivate };
