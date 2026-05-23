const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const CONFIG_SECTION = "dynamicSs13Modules";
const OUTPUT_NAME = "Dynamic Modules";
const DEFAULT_INDEX_PATH = ".dynamic_modules_build/index.json";
const LIVE_AUTHORING_SESSION = "_live";

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
    this.modulesTreeView = vscode.window.createTreeView("dynamicSs13Modules.modules", { treeDataProvider: this.modulesProvider });
    this.currentFileTreeView = vscode.window.createTreeView("dynamicSs13Modules.currentFile", { treeDataProvider: this.currentFileProvider });
    this.watchers = [];
    this.index = null;
    this.indexPath = null;
    this.root = null;
    this.commandRunning = false;
    this.openingIntegratedFile = false;
    this.repairingWorkspaceWindow = false;
    this.authoringManifestCache = new Map();

    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.warningForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground")
    });
    this.overrideStartDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: new vscode.ThemeColor("editorInfo.foreground"),
      borderStyle: "solid",
      borderWidth: "1px 0 0 3px",
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      before: {
        color: new vscode.ThemeColor("editorInfo.foreground"),
        fontWeight: "bold",
        margin: "0 1em 0 0"
      }
    });
    this.overrideChangedDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    this.overrideEndDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: new vscode.ThemeColor("editorInfo.foreground"),
      borderStyle: "solid",
      borderWidth: "0 0 1px 3px",
      after: {
        color: new vscode.ThemeColor("editorInfo.foreground"),
        fontStyle: "italic",
        margin: "0 0 0 1.5em"
      }
    });
    this.overrideRemovedDecorationType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      before: {
        color: new vscode.ThemeColor("editorError.foreground"),
        backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
        fontStyle: "italic",
        margin: "0",
        textDecoration: "line-through; display: block; white-space: pre; width: 100vw; box-sizing: border-box;"
      }
    });

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 75);
    this.statusBar.command = "dynamicSs13Modules.explainCurrentFile";

    context.subscriptions.push(
      this.output,
      this.decorationType,
      this.overrideStartDecorationType,
      this.overrideChangedDecorationType,
      this.overrideEndDecorationType,
      this.overrideRemovedDecorationType,
      this.statusBar,
      this.modulesTreeView,
      this.currentFileTreeView,
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this.codeLensProvider),
      vscode.languages.registerHoverProvider({ scheme: "file" }, this.hoverProvider),
      vscode.commands.registerCommand("dynamicSs13Modules.refresh", () => this.refresh(true)),
      vscode.commands.registerCommand("dynamicSs13Modules.prepare", () => this.prepare()),
      vscode.commands.registerCommand("dynamicSs13Modules.generateWorkspace", () => this.generateWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.openWorkspace", () => this.openGeneratedWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.restoreFolderWindow", () => this.restoreFolderWindow()),
      vscode.commands.registerCommand("dynamicSs13Modules.explainCurrentFile", () => this.explainCurrentFile()),
      vscode.commands.registerCommand("dynamicSs13Modules.focusModuleInteraction", (target) => this.focusModuleInteraction(target)),
      vscode.commands.registerCommand("dynamicSs13Modules.previewCurrentFile", () => this.previewCurrentFile()),
      vscode.commands.registerCommand("dynamicSs13Modules.openIntegratedFinalFile", () => this.openIntegratedFinalFile()),
      vscode.commands.registerCommand("dynamicSs13Modules.convertChangesToModule", () => this.convertChangesToModule()),
      vscode.commands.registerCommand("dynamicSs13Modules.generateAuthoringWorkspace", () => this.generateAuthoringWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.deconvertAuthoringWorkspace", () => this.deconvertAuthoringWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.openAuthoringWorkspace", () => this.openAuthoringWorkspace()),
      vscode.commands.registerCommand("dynamicSs13Modules.openIndex", () => this.openIndex()),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedInclude", () => this.openGeneratedFile("include_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedTests", () => this.openGeneratedFile("tests_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedConfig", () => this.openGeneratedFile("config_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openGeneratedTguiCli", () => this.openGeneratedFile("tgui_cli_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openDynamicDmIndex", () => this.openGeneratedFile("dynamic_dm_index_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openDynamicAssetsIndex", () => this.openGeneratedFile("dynamic_assets_index_file")),
      vscode.commands.registerCommand("dynamicSs13Modules.openModuleManifest", (item) => this.openModuleManifest(item)),
      vscode.commands.registerCommand("dynamicSs13Modules.addModuleRootToWorkspace", (item) => this.addModuleRootToWorkspace(item)),
      vscode.commands.registerCommand("dynamicSs13Modules.copyInteractionSummary", (item) => this.copyInteractionSummary(item)),
      vscode.commands.registerCommand("dynamicSs13Modules.openSettings", () => this.openSettings()),
      vscode.commands.registerCommand("dynamicSs13Modules.openPath", (target) => this.openPath(target)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.maybeOpenIntegratedFinalFile(editor);
        this.updateActiveFileState();
        this.maybeRevealHostFileInExplorer(editor);
      }),
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
        this.repairStaleLiveAuthoringWorkspace();
      })
    );

    this.refresh(false);
    this.configureWatchers();
    this.repairStaleLiveAuthoringWorkspace();
    this.maybeOpenIntegratedFinalFile(vscode.window.activeTextEditor);
    this.maybeRevealHostFileInExplorer(vscode.window.activeTextEditor);
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
    this.maybeOpenIntegratedFinalFile(vscode.window.activeTextEditor);

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

    const authoringManifest = vscode.workspace.getConfiguration(CONFIG_SECTION).get("authoringSessionManifest", "") || "";
    const authoringHostRoot = this.hostRootFromAuthoringManifest(authoringManifest);
    if (authoringHostRoot) {
      return authoringHostRoot;
    }

    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activePath) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activePath));
      if (folder && this.isHostWorkspaceRoot(folder.uri.fsPath)) {
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
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION, vscode.Uri.file(root)).get("indexPath", DEFAULT_INDEX_PATH) || DEFAULT_INDEX_PATH;
    return this.resolvePath(configured, root);
  }

  isHostWorkspaceRoot(root) {
    const indexPath = this.resolveConfiguredIndexPath(root);
    return Boolean(
      (indexPath && fs.existsSync(indexPath)) ||
      fs.existsSync(path.join(root, "dynamic_modules.toml"))
    );
  }

  hostRootFromAuthoringManifest(manifestPath) {
    if (!manifestPath || !manifestPath.trim()) {
      return null;
    }
    const resolved = this.resolvePath(manifestPath.trim(), this.root);
    if (!resolved || !fs.existsSync(resolved)) {
      return null;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
      const hostRoot = localizeAbsolutePath(manifest.host_root || "");
      return hostRoot && this.isHostWorkspaceRoot(hostRoot) ? hostRoot : null;
    } catch {
      return null;
    }
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
    const authoringFile = this.authoringFileForDocument(document);
    if (authoringFile?.target_file) {
      return authoringFile.target_file;
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

  authoringFileForDocument(document) {
    if (!document || document.uri.scheme !== "file") {
      return null;
    }
    return this.authoringFileForPath(document.uri.fsPath);
  }

  authoringFileForPath(filePath) {
    const authoringRoot = this.authoringRoot();
    if (!filePath || !authoringRoot) {
      return null;
    }
    const fileComparable = comparablePath(filePath);
    const rootComparable = comparablePath(authoringRoot);
    if (!startsWithPath(fileComparable, rootComparable)) {
      return null;
    }

    const relative = path.relative(authoringRoot, filePath).replace(/\\/g, "/");
    const [sessionId, rootName, ...rest] = relative.split("/");
    if (!sessionId || rootName !== "files" || !rest.length) {
      return null;
    }
    const targetFile = rest.join("/");
    const sessionRoot = path.join(authoringRoot, sessionId);
    const manifest = this.readAuthoringManifest(path.join(sessionRoot, "dynamic-authoring.json"));
    const entry = (manifest?.files || []).find((file) => comparablePath(file.target_file) === comparablePath(targetFile));
    if (!entry) {
      return {
        session_id: sessionId,
        sessionRoot,
        target_file: targetFile,
        editablePath: filePath,
        baselinePath: path.join(sessionRoot, "baseline", targetFile)
      };
    }
    return {
      ...entry,
      session_id: sessionId,
      sessionRoot,
      target_file: entry.target_file,
      editablePath: path.join(sessionRoot, entry.editable_path),
      baselinePath: path.join(sessionRoot, entry.baseline_path)
    };
  }

  readAuthoringManifest(manifestPath) {
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      return null;
    }
    const cached = this.authoringManifestCache.get(manifestPath);
    const stat = fs.statSync(manifestPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.manifest;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      this.authoringManifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, manifest });
      return manifest;
    } catch {
      return null;
    }
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
    this.codeLensProvider.refresh();
    this.updateStatusBar();
    this.updateDecorations();
  }

  async maybeOpenIntegratedFinalFile(editor) {
    if (!editor || this.openingIntegratedFile || !this.config().get("autoOpenFinalFiles", true)) {
      return;
    }
    if (!this.index || editor.document.uri.scheme !== "file") {
      return;
    }
    if (this.authoringFileForDocument(editor.document)) {
      return;
    }

    const key = this.keyForDocument(editor.document);
    if (!key || !isAuthorablePath(key)) {
      return;
    }
    const interactions = this.interactionsForDocument(editor.document);
    if (!interactions.some((interaction) => interaction.output_file)) {
      return;
    }

    const entry = this.ensureLiveAuthoringFile(key, interactions);
    if (!entry?.editablePath || comparablePath(entry.editablePath) === comparablePath(editor.document.uri.fsPath)) {
      return;
    }

    try {
      this.openingIntegratedFile = true;
      await this.ensureLiveAuthoringWorkspaceFolder(entry.sessionRoot);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.editablePath));
      await vscode.window.showTextDocument(document, {
        viewColumn: editor.viewColumn,
        preview: false,
        preserveFocus: false
      });
      await this.revealHostFileInExplorer(key);
    } catch (error) {
      this.output.appendLine(`Could not open integrated final file for ${key}: ${error.stack || error.message}`);
    } finally {
      this.openingIntegratedFile = false;
    }
  }

  async openIntegratedFinalFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file first.");
      return;
    }
    if (!this.index) {
      vscode.window.showWarningMessage("No Dynamic Modules index found. Run Dynamic Modules: Prepare.");
      return;
    }
    const key = this.keyForDocument(editor.document);
    const interactions = this.interactionsForDocument(editor.document);
    if (!key || !interactions.some((interaction) => interaction.output_file)) {
      vscode.window.showInformationMessage("No materialized module output is recorded for this file.");
      return;
    }
    const entry = this.ensureLiveAuthoringFile(key, interactions);
    if (entry?.editablePath) {
      await this.ensureLiveAuthoringWorkspaceFolder(entry.sessionRoot);
      await this.openPath(entry.editablePath);
      await this.revealHostFileInExplorer(key);
    }
  }

  async maybeRevealHostFileInExplorer(editor) {
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }
    const authoringFile = this.authoringFileForDocument(editor.document);
    if (!authoringFile?.target_file) {
      return;
    }
    await this.revealHostFileInExplorer(authoringFile.target_file);
  }

  async revealHostFileInExplorer(targetFile) {
    if (!this.config().get("revealHostFileInExplorer", true) || !targetFile) {
      return;
    }
    const hostPath = this.resolveIndexPath(targetFile);
    if (!hostPath || !fs.existsSync(hostPath)) {
      return;
    }
    await sleep(100);
    try {
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(hostPath));
    } catch (error) {
      this.output.appendLine(`Could not reveal host file in Explorer for ${targetFile}: ${error.message}`);
    }
  }

  ensureLiveAuthoringFile(targetFile, interactions) {
    const sourcePath = this.finalSourcePathForAuthoring(targetFile, interactions || []);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return null;
    }

    const sessionRoot = path.join(this.authoringRoot(), LIVE_AUTHORING_SESSION);
    const filesRoot = path.join(sessionRoot, "files");
    const baselineRoot = path.join(sessionRoot, "baseline");
    const editablePath = path.join(filesRoot, targetFile);
    const baselinePath = path.join(baselineRoot, targetFile);
    const manifestPath = path.join(sessionRoot, "dynamic-authoring.json");

    fs.mkdirSync(path.dirname(editablePath), { recursive: true });
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    this.ensureLocalGitExclude(this.authoringRoot());

    const sourceHash = sha256File(sourcePath);
    const editableExists = fs.existsSync(editablePath);
    const baselineExists = fs.existsSync(baselinePath);
    const editableChanged = editableExists && baselineExists && sha256File(editablePath) !== sha256File(baselinePath);
    const baselineChanged = !baselineExists || sha256File(baselinePath) !== sourceHash;

    if (!editableExists || (!editableChanged && baselineChanged)) {
      fs.copyFileSync(sourcePath, editablePath);
    }
    if (!baselineExists || !editableChanged) {
      fs.copyFileSync(sourcePath, baselinePath);
    }

    const manifest = this.readAuthoringManifest(manifestPath) || {
      version: 1,
      session_id: LIVE_AUTHORING_SESSION,
      live: true,
      host_root: this.localHostRoot(),
      index_path: this.indexPath,
      index_generated_at: this.index?.generated_at || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      files: []
    };
    manifest.live = true;
    manifest.host_root = this.localHostRoot();
    manifest.index_path = this.indexPath;
    manifest.index_generated_at = this.index?.generated_at || null;
    manifest.updated_at = new Date().toISOString();

    const fileEntry = {
      target_file: targetFile,
      editable_path: path.relative(sessionRoot, editablePath).replace(/\\/g, "/"),
      baseline_path: path.relative(sessionRoot, baselinePath).replace(/\\/g, "/"),
      source_path: sourcePath,
      kind: authoringKind(targetFile),
      modules: [...new Set((interactions || []).map((item) => item.module).filter(Boolean))],
      interactions: (interactions || []).map((item) => ({
        kind: item.kind,
        module: item.module,
        id: item.id,
        mode: item.mode,
        anchor_line: item.anchor_line,
        output_file: item.output_file
      })),
      baseline_sha256: sha256File(baselinePath)
    };
    const index = manifest.files.findIndex((file) => comparablePath(file.target_file) === comparablePath(targetFile));
    if (index === -1) {
      manifest.files.push(fileEntry);
    } else {
      manifest.files[index] = { ...manifest.files[index], ...fileEntry };
    }
    manifest.files.sort((left, right) => left.target_file.localeCompare(right.target_file));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    this.authoringManifestCache.delete(manifestPath);

    const workspacePath = path.join(sessionRoot, "dynamic-authoring.code-workspace");
    if (!fs.existsSync(workspacePath)) {
      fs.writeFileSync(workspacePath, `${JSON.stringify({
        folders: [
          { name: "host", path: this.localHostRoot() },
          { name: "dynamic-final", path: filesRoot }
        ],
        settings: {
          "dynamicSs13Modules.authoringSessionManifest": manifestPath
        }
      }, null, 2)}\n`, "utf8");
    }

    return {
      ...fileEntry,
      sessionRoot,
      editablePath,
      baselinePath,
      manifestPath
    };
  }

  async ensureLiveAuthoringWorkspaceFolder(sessionRoot) {
    if (!this.config().get("addLiveFinalFolderToWorkspace", false) || !sessionRoot) {
      return;
    }
    const liveFilesRoot = path.join(sessionRoot, "files");
    if (!fs.existsSync(liveFilesRoot)) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders || [];
    const alreadyOpen = folders.some((folder) => comparablePath(folder.uri.fsPath) === comparablePath(liveFilesRoot));
    if (alreadyOpen) {
      return;
    }
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri: vscode.Uri.file(liveFilesRoot),
      name: "dynamic-final"
    });
  }

  async repairStaleLiveAuthoringWorkspace(force = false) {
    if (this.repairingWorkspaceWindow) {
      return;
    }
    if (!force && !this.config().get("repairLiveAuthoringWorkspaceWindow", true)) {
      return;
    }
    if (!force && this.config().get("addLiveFinalFolderToWorkspace", false)) {
      return;
    }

    const hostRoot = this.localHostRoot();
    if (!hostRoot || !this.isHostWorkspaceRoot(hostRoot)) {
      return;
    }

    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      return;
    }

    const hostComparable = comparablePath(hostRoot);
    const liveFilesRoot = path.join(this.authoringRoot(), LIVE_AUTHORING_SESSION, "files");
    const liveComparable = comparablePath(liveFilesRoot);
    const nonDynamicRoots = folders.filter((folder) => {
      const folderComparable = comparablePath(folder.uri.fsPath);
      return folderComparable !== hostComparable && folderComparable !== liveComparable;
    });
    if (nonDynamicRoots.length) {
      return;
    }

    const hasLiveFinalRoot = folders.some((folder) => comparablePath(folder.uri.fsPath) === liveComparable);
    const onlyHostRoot = folders.length === 1 && comparablePath(folders[0].uri.fsPath) === hostComparable;
    const authoringManifest = vscode.workspace.getConfiguration(CONFIG_SECTION).get("authoringSessionManifest", "") || "";
    const hasLiveManifestSetting = this.isLiveAuthoringManifestPath(authoringManifest);
    if (!force && !hasLiveFinalRoot && !(onlyHostRoot && (hasLiveManifestSetting || this.isUntitledWorkspaceWindow()))) {
      return;
    }

    this.repairingWorkspaceWindow = true;
    try {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(hostRoot), { forceNewWindow: false });
    } catch (error) {
      this.repairingWorkspaceWindow = false;
      this.output.appendLine(`Could not restore folder window for ${hostRoot}: ${error.stack || error.message}`);
    }
  }

  isLiveAuthoringManifestPath(value) {
    if (!value || !value.trim()) {
      return false;
    }
    const resolved = this.resolvePath(value.trim(), this.root);
    const liveManifest = path.join(this.authoringRoot(), LIVE_AUTHORING_SESSION, "dynamic-authoring.json");
    return comparablePath(resolved) === comparablePath(liveManifest);
  }

  isUntitledWorkspaceWindow() {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile?.scheme === "untitled") {
      return true;
    }
    return /^Untitled \(Workspace\)$/i.test(vscode.workspace.name || "");
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
      editor.setDecorations(this.overrideStartDecorationType, []);
      editor.setDecorations(this.overrideChangedDecorationType, []);
      editor.setDecorations(this.overrideEndDecorationType, []);
      editor.setDecorations(this.overrideRemovedDecorationType, []);
      return;
    }

    const interactions = this.interactionsForDocument(editor.document);
    const blocks = this.overrideBlocksForDocument(editor.document, interactions);
    const blockInteractionKeys = new Set();
    for (const block of blocks) {
      for (const interaction of block.interactions) {
        blockInteractionKeys.add(interactionKey(interaction));
      }
    }

    const decorations = [];
    for (const interaction of interactions) {
      if (blockInteractionKeys.has(interactionKey(interaction))) {
        continue;
      }
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
    this.updateOverrideBlockDecorations(editor, interactions, blocks);
  }

  updateOverrideBlockDecorations(editor, interactions, blocks = null) {
    if (!this.config().get("showInlineOverrideBlocks", true)) {
      editor.setDecorations(this.overrideStartDecorationType, []);
      editor.setDecorations(this.overrideChangedDecorationType, []);
      editor.setDecorations(this.overrideEndDecorationType, []);
      editor.setDecorations(this.overrideRemovedDecorationType, []);
      return;
    }
    blocks ??= this.overrideBlocksForDocument(editor.document, interactions);
    if (!blocks.length) {
      editor.setDecorations(this.overrideStartDecorationType, []);
      editor.setDecorations(this.overrideChangedDecorationType, []);
      editor.setDecorations(this.overrideEndDecorationType, []);
      editor.setDecorations(this.overrideRemovedDecorationType, []);
      return;
    }

    const changedDecorations = [];
    const removedDecorations = [];
    for (const block of blocks) {
      if (block.hunk.removed.length) {
        removedDecorations.push({
          range: new vscode.Range(block.startLine, 0, block.startLine, 0),
          hoverMessage: block.hover,
          renderOptions: {
            before: {
              contentText: removedGhostText(block.hunk.removed)
            }
          }
        });
      }

      const lineEnd = Math.max(block.hunk.newEnd, block.hunk.newStart + 1);
      for (let line = block.hunk.newStart; line < lineEnd; line += 1) {
        const changedLine = clampLine(editor.document, line);
        changedDecorations.push({
          range: editor.document.lineAt(changedLine).range,
          hoverMessage: block.hover
        });
      }
    }

    editor.setDecorations(this.overrideStartDecorationType, []);
    editor.setDecorations(this.overrideChangedDecorationType, changedDecorations);
    editor.setDecorations(this.overrideEndDecorationType, []);
    editor.setDecorations(this.overrideRemovedDecorationType, removedDecorations);
  }

  overrideBlocksForDocument(document, interactions = this.interactionsForDocument(document)) {
    if (!this.config().get("showInlineOverrideBlocks", true)) {
      return [];
    }
    const targetFile = this.keyForDocument(document);
    if (!targetFile || !interactions.length) {
      return [];
    }

    const basePath = this.resolveIndexPath(targetFile);
    if (!basePath || !fs.existsSync(basePath)) {
      return [];
    }
    let baseText;
    try {
      baseText = fs.readFileSync(basePath, "utf8");
    } catch {
      return [];
    }

    const hunks = diffLineHunks(baseText, document.getText());
    return hunks.map((hunk, index) => {
      const hunkInteractions = interactionsForHunk(hunk, interactions);
      const modules = [...new Set(hunkInteractions.map((interaction) => interaction.module).filter(Boolean))].sort();
      const moduleLabel = modules.length ? modules.join(", ") : "unknown module";
      const startLine = clampLine(document, hunk.newStart);
      const endLine = clampLine(document, Math.max(hunk.newStart, hunk.newEnd - 1));
      const removedVisualRows = hunk.removed.length ? Math.max(1, hunk.removed.length) : 0;
      const afterLine = hunk.newEnd < document.lineCount
        ? clampLine(document, hunk.newEnd + removedVisualRows)
        : endLine;
      const hover = new vscode.MarkdownString(undefined, true);
      hover.supportHtml = false;
      hover.appendMarkdown(`**MODULAR OVERRIDE FROM: ${escapeMarkdown(moduleLabel)}**\n\n`);
      hover.appendMarkdown(`${escapeMarkdown(targetFile)}\n\n`);
      if (hunk.removed.length) {
        hover.appendMarkdown("_Removed base lines:_\n\n");
        hover.appendCodeblock(hunk.removed.join("\n"), languageForPath(targetFile));
      }
      if (hunk.added.length) {
        hover.appendMarkdown("_Final lines:_\n\n");
        hover.appendCodeblock(hunk.added.join("\n"), languageForPath(targetFile));
      }
      return {
        index,
        hunk,
        interactions: hunkInteractions,
        modules,
        moduleLabel,
        targetFile,
        startLine,
        endLine,
        afterLine,
        hover
      };
    });
  }

  focusTargetForBlock(block) {
    const interaction = block.interactions[0] || {};
    return {
      moduleId: block.modules[0] || interaction.module || null,
      targetFile: block.targetFile,
      interactionKey: interactionKey(interaction),
      interactionKind: interaction.kind || null,
      interactionId: interaction.id || null,
      anchorLine: interaction.anchor_line || null,
      hunkIndex: block.index
    };
  }

  focusTargetForInteraction(interaction) {
    return {
      moduleId: interaction.module || null,
      targetFile: interaction.target_file || null,
      interactionKey: interactionKey(interaction),
      interactionKind: interaction.kind || null,
      interactionId: interaction.id || null,
      anchorLine: interaction.anchor_line || null
    };
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

  async convertChangesToModule() {
    if (!this.root) {
      vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      return;
    }
    if (!fs.existsSync(path.join(this.root, ".git"))) {
      vscode.window.showWarningMessage("Convert Changes to Module needs a Git checkout.");
      return;
    }

    const base = await this.pickConversionBaseRef();
    if (!base) {
      return;
    }

    const changes = this.collectGitChanges(base);
    if (!changes.length) {
      vscode.window.showInformationMessage(`No convertible branch or working-tree changes found against ${base}.`);
      return;
    }

    const selectedPicks = await vscode.window.showQuickPick(changes.map((change) => ({
      label: `${change.status} ${change.file}`,
      description: conversionKindLabel(change.file),
      detail: change.oldFile && change.oldFile !== change.file ? `Renamed from ${change.oldFile}` : undefined,
      picked: true,
      change
    })), {
      canPickMany: true,
      placeHolder: "Choose files to convert into a Dynamic Module"
    });
    if (!selectedPicks?.length) {
      return;
    }
    const selectedChanges = selectedPicks.map((pick) => pick.change);

    const target = await this.pickConversionTarget();
    if (!target) {
      return;
    }

    const plan = this.buildConversionPlan(base, target, selectedChanges);
    if (!planHasConvertibleOutput(plan)) {
      vscode.window.showWarningMessage("No safe module output could be generated. See the Dynamic Modules output channel.");
      this.showConversionReport(plan);
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Convert ${selectedChanges.length} changed file${selectedChanges.length === 1 ? "" : "s"} into ${target.moduleId}?`,
      { modal: true },
      "Convert"
    );
    if (confirm !== "Convert") {
      return;
    }

    try {
      this.writeConversionPlan(plan);
    } catch (error) {
      this.showConversionReport(plan);
      this.output.appendLine("");
      this.output.appendLine(`Conversion failed: ${error.stack || error.message}`);
      this.output.show(true);
      vscode.window.showErrorMessage("Dynamic Modules conversion failed. See the Dynamic Modules output channel.");
      return;
    }
    this.showConversionReport(plan);
    this.modulesProvider.refresh();

    const actions = ["Run Prepare", "Open Manifest", "Show Report"];
    const action = await vscode.window.showInformationMessage(
      `Dynamic Modules: converted changes into ${target.moduleId}.`,
      ...actions
    );
    if (action === "Run Prepare") {
      await this.prepare();
    } else if (action === "Open Manifest") {
      await this.openPath(plan.manifestPath);
    } else if (action === "Show Report") {
      this.output.show(true);
    }
  }

  async generateAuthoringWorkspace() {
    if (!this.root) {
      vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      return;
    }
    const prepareResult = await this.prepare();
    if (prepareResult !== 0) {
      return;
    }
    this.refresh(false);
    if (!this.index) {
      vscode.window.showWarningMessage("No Dynamic Modules index found after prepare.");
      return;
    }

    const candidates = this.authoringCandidates();
    if (!candidates.length) {
      vscode.window.showInformationMessage("No editable final files were found in the Dynamic Modules index.");
      return;
    }
    const activeKey = vscode.window.activeTextEditor ? this.keyForDocument(vscode.window.activeTextEditor.document) : null;
    const picks = await vscode.window.showQuickPick(candidates.map((candidate) => ({
      label: candidate.target_file,
      description: candidate.sourceKind,
      detail: candidate.modules.length ? `Touched by ${candidate.modules.join(", ")}` : candidate.sourcePath,
      picked: activeKey ? candidate.target_file === activeKey : candidate.interactions.length > 0,
      candidate
    })), {
      canPickMany: true,
      placeHolder: "Choose final files to copy into an authoring workspace"
    });
    if (!picks?.length) {
      return;
    }

    const session = this.createAuthoringSession(picks.map((pick) => pick.candidate));
    const actions = ["Open Workspace", "Open Folder", "Show Report"];
    const action = await vscode.window.showInformationMessage(
      `Dynamic Modules: authoring workspace generated with ${session.files.length} file${session.files.length === 1 ? "" : "s"}.`,
      ...actions
    );
    if (action === "Open Workspace") {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(session.workspacePath), { forceNewWindow: false });
    } else if (action === "Open Folder") {
      await this.openPath(session.filesRoot);
    } else if (action === "Show Report") {
      this.output.show(true);
    }
  }

  authoringCandidates() {
    const files = this.index?.files || {};
    const candidates = [];
    const seen = new Set();
    for (const [targetFile, interactions] of Object.entries(files)) {
      if (!isAuthorablePath(targetFile)) {
        continue;
      }
      const sourcePath = this.finalSourcePathForAuthoring(targetFile, interactions || []);
      if (!sourcePath || !fs.existsSync(sourcePath) || seen.has(targetFile)) {
        continue;
      }
      seen.add(targetFile);
      candidates.push({
        target_file: targetFile,
        sourcePath,
        sourceKind: sourcePath.includes(`${path.sep}.dynamic_modules_build${path.sep}`) ? "materialized output" : "host source",
        interactions: interactions || [],
        modules: [...new Set((interactions || []).map((item) => item.module).filter(Boolean))]
      });
    }
    const activeKey = vscode.window.activeTextEditor ? this.keyForDocument(vscode.window.activeTextEditor.document) : null;
    if (activeKey && isAuthorablePath(activeKey) && !seen.has(activeKey)) {
      const activePath = this.resolveIndexPath(activeKey);
      if (activePath && fs.existsSync(activePath)) {
        candidates.push({
          target_file: activeKey,
          sourcePath: activePath,
          sourceKind: "active host source",
          interactions: [],
          modules: []
        });
      }
    }
    return candidates.sort((left, right) => left.target_file.localeCompare(right.target_file));
  }

  finalSourcePathForAuthoring(targetFile, interactions) {
    const outputInteractions = [...interactions]
      .filter((item) => item.output_file)
      .reverse();
    for (const interaction of outputInteractions) {
      const outputPath = this.resolveBuildOutputPath(interaction.output_file);
      if (outputPath && fs.existsSync(outputPath)) {
        return outputPath;
      }
    }
    const hostPath = this.resolveIndexPath(targetFile);
    return hostPath && fs.existsSync(hostPath) ? hostPath : null;
  }

  createAuthoringSession(candidates) {
    const authoringRoot = this.authoringRoot();
    const sessionId = authoringSessionId();
    const sessionRoot = path.join(authoringRoot, sessionId);
    const filesRoot = path.join(sessionRoot, "files");
    const baselineRoot = path.join(sessionRoot, "baseline");
    const files = [];

    fs.mkdirSync(filesRoot, { recursive: true });
    fs.mkdirSync(baselineRoot, { recursive: true });
    this.ensureLocalGitExclude(authoringRoot);

    for (const candidate of candidates) {
      const editablePath = path.join(filesRoot, candidate.target_file);
      const baselinePath = path.join(baselineRoot, candidate.target_file);
      fs.mkdirSync(path.dirname(editablePath), { recursive: true });
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.copyFileSync(candidate.sourcePath, editablePath);
      fs.copyFileSync(candidate.sourcePath, baselinePath);
      files.push({
        target_file: candidate.target_file,
        editable_path: path.relative(sessionRoot, editablePath).replace(/\\/g, "/"),
        baseline_path: path.relative(sessionRoot, baselinePath).replace(/\\/g, "/"),
        source_path: candidate.sourcePath,
        kind: authoringKind(candidate.target_file),
        modules: candidate.modules,
        interactions: candidate.interactions.map((item) => ({
          kind: item.kind,
          module: item.module,
          id: item.id,
          mode: item.mode,
          output_file: item.output_file
        })),
        baseline_sha256: sha256File(baselinePath)
      });
    }

    const manifest = {
      version: 1,
      session_id: sessionId,
      host_root: this.localHostRoot(),
      index_path: this.indexPath,
      index_generated_at: this.index?.generated_at || null,
      created_at: new Date().toISOString(),
      files
    };
    const manifestPath = path.join(sessionRoot, "dynamic-authoring.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const workspacePath = path.join(sessionRoot, "dynamic-authoring.code-workspace");
    fs.writeFileSync(workspacePath, `${JSON.stringify({
      folders: [
        { name: "host", path: this.localHostRoot() },
        { name: `authoring:${sessionId}`, path: filesRoot }
      ],
      settings: {
        "dynamicSs13Modules.authoringSessionManifest": manifestPath
      }
    }, null, 2)}\n`, "utf8");

    this.output.clear();
    this.output.appendLine(`Dynamic Modules authoring workspace: ${sessionId}`);
    this.output.appendLine(`Root: ${sessionRoot}`);
    for (const file of files) {
      this.output.appendLine(`author ${file.target_file}`);
    }
    return { sessionId, sessionRoot, filesRoot, manifestPath, workspacePath, files };
  }

  async openAuthoringWorkspace() {
    const session = await this.pickAuthoringSession();
    if (!session) {
      return;
    }
    const workspacePath = path.join(session.root, "dynamic-authoring.code-workspace");
    if (fs.existsSync(workspacePath)) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspacePath), { forceNewWindow: false });
      return;
    }
    await this.openPath(path.join(session.root, "files"));
  }

  async deconvertAuthoringWorkspace() {
    if (!this.root) {
      vscode.window.showWarningMessage("No Dynamic Modules workspace folder is open.");
      return;
    }
    const session = await this.pickAuthoringSession();
    if (!session) {
      return;
    }
    const changed = this.changedAuthoringFiles(session);
    if (!changed.length) {
      vscode.window.showInformationMessage("No authoring file edits were detected in that session.");
      return;
    }
    const picks = await vscode.window.showQuickPick(changed.map((file) => ({
      label: file.target_file,
      description: file.kind,
      detail: file.modules?.length ? `Baseline included ${file.modules.join(", ")}` : "",
      picked: true,
      file
    })), {
      canPickMany: true,
      placeHolder: "Choose authoring edits to deconvert into a new module"
    });
    if (!picks?.length) {
      return;
    }
    const target = await this.pickNewAuthoringModuleTarget();
    if (!target) {
      return;
    }
    const selected = picks.map((pick) => pick.file);
    const confirm = await vscode.window.showWarningMessage(
      `Deconvert ${selected.length} authoring edit${selected.length === 1 ? "" : "s"} into ${target.moduleId}?`,
      { modal: true },
      "Deconvert"
    );
    if (confirm !== "Deconvert") {
      return;
    }

    try {
      const report = this.deconvertAuthoringFiles(session, selected, target);
      this.showAuthoringDeconvertReport(report);
      const actions = ["Run Prepare", "Open Manifest", "Show Report"];
      const action = await vscode.window.showInformationMessage(
        `Dynamic Modules: deconverted authoring edits into ${target.moduleId}.`,
        ...actions
      );
      if (action === "Run Prepare") {
        await this.prepare();
      } else if (action === "Open Manifest") {
        await this.openPath(target.manifestPath);
      } else if (action === "Show Report") {
        this.output.show(true);
      }
    } catch (error) {
      this.output.appendLine("");
      this.output.appendLine(`Authoring deconvert failed: ${error.stack || error.message}`);
      this.output.show(true);
      vscode.window.showErrorMessage("Dynamic Modules authoring deconvert failed. See the Dynamic Modules output channel.");
    }
  }

  async pickNewAuthoringModuleTarget() {
    const moduleId = await vscode.window.showInputBox({
      prompt: "New module id for deconverted authoring edits",
      placeHolder: "repo-edits",
      validateInput: (value) => /^[a-z0-9][a-z0-9_-]*$/.test(value)
        ? undefined
        : "Use lowercase letters, numbers, hyphens, or underscores."
    });
    if (!moduleId) {
      return null;
    }
    const moduleName = await vscode.window.showInputBox({
      prompt: "New module display name",
      value: titleCaseModuleId(moduleId)
    });
    if (!moduleName) {
      return null;
    }
    const defaultRoot = this.config().get("defaultLocalModuleRoot", "dynamic_modules/local") || "dynamic_modules/local";
    const moduleRootInput = await vscode.window.showInputBox({
      prompt: "New module folder, relative to the host repo unless absolute",
      value: posixJoin(defaultRoot, moduleId)
    });
    if (!moduleRootInput) {
      return null;
    }
    const moduleRoot = this.resolvePath(moduleRootInput, this.root);
    return {
      moduleId,
      moduleName,
      moduleRoot,
      manifestPath: path.join(moduleRoot, `${moduleId}.module.toml`)
    };
  }

  pickAuthoringSession() {
    const root = this.authoringRoot();
    if (!fs.existsSync(root)) {
      vscode.window.showWarningMessage("No Dynamic Modules authoring sessions found.");
      return Promise.resolve(null);
    }
    const sessions = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const sessionRoot = path.join(root, entry.name);
        const manifestPath = path.join(sessionRoot, "dynamic-authoring.json");
        if (!fs.existsSync(manifestPath)) {
          return null;
        }
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          return {
            id: entry.name,
            root: sessionRoot,
            manifestPath,
            manifest,
            changedCount: this.changedAuthoringFiles({ root: sessionRoot, manifest }).length
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.id.localeCompare(left.id));
    if (!sessions.length) {
      vscode.window.showWarningMessage("No Dynamic Modules authoring sessions found.");
      return Promise.resolve(null);
    }
    return vscode.window.showQuickPick(sessions.map((session) => ({
      label: session.id,
      description: `${session.changedCount} changed`,
      detail: session.manifest.created_at || session.root,
      session
    })), { placeHolder: "Choose an authoring session" }).then((pick) => pick?.session || null);
  }

  changedAuthoringFiles(session) {
    const files = session.manifest?.files || [];
    return files.map((file) => {
      const editablePath = path.join(session.root, file.editable_path);
      const baselinePath = path.join(session.root, file.baseline_path);
      return { ...file, editablePath, baselinePath };
    }).filter((file) => {
      if (!fs.existsSync(file.editablePath) || !fs.existsSync(file.baselinePath)) {
        return false;
      }
      return sha256File(file.editablePath) !== sha256File(file.baselinePath);
    });
  }

  deconvertAuthoringFiles(session, files, target) {
    fs.mkdirSync(target.moduleRoot, { recursive: true });
    const report = {
      session,
      target,
      converted: [],
      unsupported: [],
      commandOutputs: []
    };
    const dmFiles = files.filter((file) => file.kind === "dm");
    const tguiFiles = files.filter((file) => file.kind === "tgui");
    const assetFiles = files.filter((file) => file.kind === "asset");
    const otherFiles = files.filter((file) => !["dm", "tgui", "asset"].includes(file.kind));

    if (!fs.existsSync(target.manifestPath)) {
      fs.writeFileSync(target.manifestPath, renderAuthoringModuleManifest(target), "utf8");
    }

    const tempRepo = this.createAuthoringTempRepo(files);
    const convertedGroups = {
      dmFiles: [],
      tguiFiles: [],
      assetFiles: []
    };
    try {
      if (dmFiles.length) {
        convertedGroups.dmFiles.push(...this.runDynamicDmAuthoringConversion(tempRepo, dmFiles, target, report));
      }
      for (const file of tguiFiles) {
        if (this.runDynamicTguiAuthoringConversion(tempRepo, file, target, report)) {
          convertedGroups.tguiFiles.push(file);
        }
      }
      for (const file of assetFiles) {
        this.copyAuthoringAsset(file, target, report);
        convertedGroups.assetFiles.push(file);
      }
      for (const file of otherFiles) {
        report.unsupported.push(`${file.target_file}: no deconverter is registered for ${file.kind} files.`);
      }
      this.finalizeAuthoringManifest(target, convertedGroups);
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
    return report;
  }

  createAuthoringTempRepo(files) {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-modules-authoring-"));
    for (const file of files) {
      const tempPath = path.join(tempRepo, file.target_file);
      fs.mkdirSync(path.dirname(tempPath), { recursive: true });
      fs.copyFileSync(file.baselinePath, tempPath);
    }
    this.gitIn(tempRepo, ["init", "-q"]);
    this.gitIn(tempRepo, ["config", "user.name", "Dynamic Modules Authoring"]);
    this.gitIn(tempRepo, ["config", "user.email", "dynamic-modules@example.invalid"]);
    this.gitIn(tempRepo, ["add", "."]);
    this.gitIn(tempRepo, ["commit", "-q", "-m", "authoring baseline"]);
    for (const file of files) {
      fs.copyFileSync(file.editablePath, path.join(tempRepo, file.target_file));
    }
    return tempRepo;
  }

  runDynamicDmAuthoringConversion(tempRepo, files, target, report) {
    const moduleRoot = this.dynamicDmRootPath();
    if (!moduleRoot || !fs.existsSync(path.join(moduleRoot, "dynamic_dm"))) {
      for (const file of files) {
        report.unsupported.push(`${file.target_file}: dynamic-dm Python module is unavailable.`);
      }
      return [];
    }
    const pythonPath = this.config().get("pythonPath", "python3") || "python3";
    const args = [
      "-m",
      "dynamic_dm",
      "migrate-modified",
      "--repo-root",
      tempRepo,
      "--upstream-ref",
      "HEAD",
      "--module-id",
      target.moduleId,
      "--module-name",
      target.moduleName,
      "--out-dir",
      target.moduleRoot,
      "--targets",
      files.map((file) => file.target_file).join(",")
    ];
    const result = this.spawnAuthoringCommand(pythonPath, args, moduleRoot, "Dynamic DM authoring conversion");
    report.commandOutputs.push(result);
    if (result.error) {
      for (const file of files) {
        report.unsupported.push(`${file.target_file}: Dynamic DM conversion failed.`);
      }
      return [];
    }
    const convertedTargets = parseDynamicDmConvertedTargets(result.stdout);
    const convertedSet = new Set(convertedTargets.length ? convertedTargets : result.status === 0 ? files.map((file) => file.target_file) : []);
    const convertedFiles = [];
    for (const file of files) {
      if (convertedSet.has(file.target_file)) {
        report.converted.push(`${file.target_file}: Dynamic DM`);
        convertedFiles.push(file);
      } else {
        report.unsupported.push(`${file.target_file}: Dynamic DM conversion did not produce a patch.`);
      }
    }
    return convertedFiles;
  }

  runDynamicTguiAuthoringConversion(tempRepo, file, target, report) {
    const dynamicTguiCli = this.dynamicTguiCliPath();
    if (!dynamicTguiCli || !fs.existsSync(dynamicTguiCli)) {
      report.unsupported.push(`${file.target_file}: Dynamic TGUI CLI is unavailable.`);
      return;
    }
    const bunPath = this.config().get("bunPath", "bun") || "bun";
    const tguiTarget = file.target_file.replace(/^tgui\//, "");
    const outputDir = path.join(target.moduleRoot, "tgui", "converted");
    const result = this.spawnAuthoringCommand(
      bunPath,
      [
        dynamicTguiCli,
        "create-override",
        "--target",
        tguiTarget,
        "--out-dir",
        outputDir,
        "--upstream-ref",
        "HEAD"
      ],
      tempRepo,
      "Dynamic TGUI authoring conversion",
      {
        DYNAMIC_MODULES_HOST_ROOT: tempRepo,
        DYNAMIC_TGUI_ROOT: path.join(tempRepo, "tgui"),
        DYNAMIC_MODULES_INDEX: this.indexPath || path.join(this.root, DEFAULT_INDEX_PATH)
      }
    );
    report.commandOutputs.push(result);
    if (result.status !== 0 || result.error) {
      report.unsupported.push(`${file.target_file}: Dynamic TGUI conversion failed.`);
      return false;
    }
    report.converted.push(`${file.target_file}: Dynamic TGUI`);
    return true;
  }

  copyAuthoringAsset(file, target, report) {
    const relative = uniqueModulePath(target.moduleRoot, posixJoin("assets/authoring", file.target_file));
    const outputPath = path.join(target.moduleRoot, relative);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(file.editablePath, outputPath);
    report.converted.push(`${file.target_file}: Dynamic Assets copy`);
  }

  finalizeAuthoringManifest(target, groups) {
    let text = fs.readFileSync(target.manifestPath, "utf8");
    const requires = [];
    if (groups.dmFiles.length) {
      requires.push("dynamic-dm");
    }
    if (groups.tguiFiles.length) {
      requires.push("dynamic-tgui");
      text = ensureTomlArrayValues(text, "build", "tgui", ["tgui/**/*.tgui.ts"]);
    }
    if (groups.assetFiles.length) {
      requires.push("dynamic-assets");
      text = ensureTomlArrayValues(text, "build", "assets", ["assets/**/*"]);
    }
    if (requires.length) {
      text = ensureTomlArrayValues(text, "load", "requires", requires);
    }
    fs.writeFileSync(target.manifestPath, ensureTrailingNewline(text), "utf8");
  }

  showAuthoringDeconvertReport(report) {
    this.output.clear();
    this.output.appendLine(`Dynamic Modules authoring deconvert: ${report.target.moduleId}`);
    this.output.appendLine(`Session: ${report.session.id}`);
    this.output.appendLine(`Module root: ${report.target.moduleRoot}`);
    this.output.appendLine("");
    for (const item of report.converted) {
      this.output.appendLine(`converted ${item}`);
    }
    if (report.commandOutputs.length) {
      this.output.appendLine("");
      this.output.appendLine("Command output:");
      for (const output of report.commandOutputs) {
        this.output.appendLine(`## ${output.title}`);
        this.appendCommandOutput(output.stdout, output.stderr);
      }
    }
    if (report.unsupported.length) {
      this.output.appendLine("");
      this.output.appendLine("Skipped or needs manual conversion:");
      for (const item of report.unsupported) {
        this.output.appendLine(`- ${item}`);
      }
    }
    this.output.show(true);
  }

  spawnAuthoringCommand(file, args, cwd, title, env = {}) {
    this.output.appendLine(`$ ${file} ${args.map(shellishQuote).join(" ")}`);
    const result = childProcess.spawnSync(file, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 40,
      windowsHide: true
    });
    return {
      title,
      status: result.status,
      error: result.error,
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  }

  dynamicDmRootPath() {
    const configured = this.config().get("dynamicDmRoot", "") || "";
    if (configured.trim()) {
      return this.resolvePath(configured.trim(), this.root);
    }
    const moduleRoot = this.index?.modules?.["dynamic-dm"]?.root
      ? this.resolveIndexPath(this.index.modules["dynamic-dm"].root)
      : path.join(this.root, "dynamic_modules", "installed", "dynamic-dm");
    return moduleRoot;
  }

  authoringRoot() {
    const configured = this.config().get("authoringRoot", ".dynamic_modules_authoring") || ".dynamic_modules_authoring";
    return this.resolvePath(configured, this.root);
  }

  gitIn(cwd, args) {
    return childProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
      windowsHide: true
    }).trimEnd();
  }

  ensureLocalGitExclude(targetPath) {
    const hostRoot = this.localHostRoot();
    const gitDir = gitDirForRoot(hostRoot);
    if (!hostRoot || !gitDir) {
      return;
    }
    const relative = path.relative(hostRoot, targetPath).replace(/\\/g, "/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      return;
    }
    const entry = `${relative.replace(/\/+$/, "")}/`;
    const excludePath = path.join(gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (existing.split(/\r?\n/).includes(entry)) {
      return;
    }
    fs.appendFileSync(excludePath, `${existing.endsWith("\n") || !existing ? "" : "\n"}${entry}\n`, "utf8");
  }

  async pickConversionBaseRef() {
    const configured = this.config().get("defaultConvertBase", "").trim();
    const candidates = [];
    if (configured) {
      candidates.push(configured);
    }
    candidates.push(...this.defaultBaseCandidates());
    const uniqueCandidates = [...new Set(candidates)].filter((candidate) => this.gitRefExists(candidate));
    const items = uniqueCandidates.map((candidate, index) => ({
      label: candidate,
      description: index === 0 ? "default" : "",
      ref: candidate
    }));
    items.push({ label: "Custom ref...", description: "Enter a branch, tag, or commit", ref: null });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose the base ref for branch changes"
    });
    if (!pick) {
      return null;
    }
    if (pick.ref) {
      return pick.ref;
    }
    const custom = await vscode.window.showInputBox({
      prompt: "Base ref to diff against",
      placeHolder: "origin/main"
    });
    return custom?.trim() || null;
  }

  defaultBaseCandidates() {
    const candidates = [];
    try {
      const originHead = this.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
      if (originHead) {
        candidates.push(originHead.replace(/^origin\//, "origin/"));
      }
    } catch {
      // Fall through to common branch names.
    }
    candidates.push("origin/main", "main", "origin/master", "master", "HEAD");
    return candidates;
  }

  gitRefExists(ref) {
    try {
      this.git(["rev-parse", "--verify", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  collectGitChanges(base) {
    const byFile = new Map();
    const diffOutput = this.git(["diff", "--name-status", "-M", base, "--", "."]);
    for (const line of diffOutput.split(/\r?\n/).filter(Boolean)) {
      const parts = line.split("\t");
      const status = parts[0] || "M";
      if (status.startsWith("R") && parts.length >= 3) {
        byFile.set(parts[2], { status: "M", oldFile: parts[1], file: parts[2] });
      } else if (parts.length >= 2) {
        byFile.set(parts[1], { status: status[0], file: parts[1] });
      }
    }

    const untracked = this.git(["ls-files", "--others", "--exclude-standard", "--", "."]);
    for (const file of untracked.split(/\r?\n/).filter(Boolean)) {
      if (!byFile.has(file)) {
        byFile.set(file, { status: "A", file });
      }
    }

    return [...byFile.values()]
      .filter((change) => shouldOfferConversion(change.file))
      .sort((left, right) => left.file.localeCompare(right.file));
  }

  async pickConversionTarget() {
    const targetKind = await vscode.window.showQuickPick([
      { label: "Create new module", description: "Write a new module under dynamic_modules/local", value: "new" },
      { label: "Add to existing module", description: "Write generated files into a resolved module root", value: "existing" }
    ], { placeHolder: "Where should the converted changes go?" });
    if (!targetKind) {
      return null;
    }

    if (targetKind.value === "existing") {
      const modules = this.index?.modules || {};
      const moduleIds = Object.keys(modules).sort();
      if (!moduleIds.length) {
        vscode.window.showWarningMessage("No modules are available in the generated index. Run Prepare first or create a new module.");
        return null;
      }
      const pick = await vscode.window.showQuickPick(moduleIds.map((moduleId) => ({
        label: moduleId,
        description: modules[moduleId].name || "",
        detail: modules[moduleId].root || "",
        moduleId
      })), { placeHolder: "Choose the module to receive converted changes" });
      if (!pick) {
        return null;
      }
      const moduleData = modules[pick.moduleId];
      const moduleRoot = this.resolveIndexPath(moduleData.root);
      const manifestPath = this.resolveIndexPath(moduleData.manifest);
      return {
        kind: "existing",
        moduleId: pick.moduleId,
        moduleName: moduleData.name || pick.moduleId,
        moduleRoot,
        manifestPath
      };
    }

    const moduleId = await vscode.window.showInputBox({
      prompt: "New module id",
      placeHolder: "example-feature",
      validateInput: (value) => /^[a-z0-9][a-z0-9_-]*$/.test(value)
        ? undefined
        : "Use lowercase letters, numbers, hyphens, or underscores."
    });
    if (!moduleId) {
      return null;
    }
    const moduleName = await vscode.window.showInputBox({
      prompt: "New module display name",
      value: titleCaseModuleId(moduleId)
    });
    if (!moduleName) {
      return null;
    }
    const defaultRoot = this.config().get("defaultLocalModuleRoot", "dynamic_modules/local") || "dynamic_modules/local";
    const moduleRootInput = await vscode.window.showInputBox({
      prompt: "New module folder, relative to the host repo unless absolute",
      value: posixJoin(defaultRoot, moduleId)
    });
    if (!moduleRootInput) {
      return null;
    }
    const moduleRoot = this.resolvePath(moduleRootInput, this.root);
    return {
      kind: "new",
      moduleId,
      moduleName,
      moduleRoot,
      manifestPath: path.join(moduleRoot, `${moduleId}.module.toml`)
    };
  }

  buildConversionPlan(base, target, changes) {
    const plan = {
      base,
      target,
      moduleId: target.moduleId,
      moduleRoot: target.moduleRoot,
      manifestPath: target.manifestPath,
      writes: [],
      copies: [],
      commands: [],
      patches: [],
      build: {
        dm_files: new Set(),
        test_files: new Set(),
        assets: new Set(),
        tgui: new Set()
      },
      requires: new Set(),
      unsupported: [],
      notes: [],
      manifestText: null
    };

    for (const change of changes) {
      this.addChangeToConversionPlan(plan, change);
    }

    if ([...plan.build.assets].length) {
      plan.requires.add("dynamic-assets");
    }

    plan.manifestText = target.kind === "new"
      ? renderNewModuleManifest(plan)
      : updateExistingManifest(target.manifestPath, plan);
    return plan;
  }

  addChangeToConversionPlan(plan, change) {
    const sourcePath = path.join(this.root, change.file);
    if (change.status === "D") {
      plan.unsupported.push(`${change.file}: deletions are not safely representable by the current patch engine.`);
      return;
    }

    if (change.status === "A") {
      if (isTguiSourcePath(change.file)) {
        plan.unsupported.push(`${change.file}: new TGUI files need a hand-authored Dynamic TGUI manifest or support-file wiring.`);
        return;
      }
      this.addAddedFileToPlan(plan, change, sourcePath);
      return;
    }

    if (isTguiSourcePath(change.file)) {
      this.addTguiSmartConversionToPlan(plan, change, sourcePath);
      return;
    }

    if (isBinaryLikePath(change.file)) {
      this.addAssetCopyToPlan(plan, change, sourcePath);
      plan.notes.push(`${change.file}: copied as a Dynamic Assets contribution; core asset replacement is metadata-only for now.`);
      return;
    }

    const patchResults = this.convertDiffToPatches(plan, change);
    if (!patchResults.length) {
      plan.unsupported.push(`${change.file}: no safe additive or single-line replacement patches were detected.`);
    }
  }

  addAddedFileToPlan(plan, change, sourcePath) {
    if (!fs.existsSync(sourcePath)) {
      plan.unsupported.push(`${change.file}: added file is missing from the working tree.`);
      return;
    }
    if (isDmPath(change.file)) {
      const targetRoot = isTestDmPath(change.file) ? "tests/host" : "code/host";
      const relative = uniqueModulePath(plan.moduleRoot, posixJoin(targetRoot, change.file));
      plan.copies.push({ from: sourcePath, to: path.join(plan.moduleRoot, relative) });
      if (isTestDmPath(change.file)) {
        plan.build.test_files.add("tests/**/*.dm");
      } else {
        plan.build.dm_files.add("code/**/*.dm");
      }
      plan.notes.push(`${change.file}: copied as module DM source.`);
      return;
    }
    this.addAssetCopyToPlan(plan, change, sourcePath);
  }

  addAssetCopyToPlan(plan, change, sourcePath) {
    if (!fs.existsSync(sourcePath)) {
      plan.unsupported.push(`${change.file}: current asset file is missing.`);
      return;
    }
    const relative = uniqueModulePath(plan.moduleRoot, posixJoin("assets/host", change.file));
    plan.copies.push({ from: sourcePath, to: path.join(plan.moduleRoot, relative) });
    plan.build.assets.add("assets/**/*");
  }

  addTguiSmartConversionToPlan(plan, change, sourcePath) {
    if (!fs.existsSync(sourcePath)) {
      plan.unsupported.push(`${change.file}: current TGUI file is missing.`);
      return;
    }
    const dynamicTguiCli = this.dynamicTguiCliPath();
    if (!dynamicTguiCli || !fs.existsSync(dynamicTguiCli)) {
      plan.unsupported.push(`${change.file}: dynamic-tgui tools/cli.ts is unavailable; install/run prepare with dynamic-tgui first.`);
      return;
    }
    const target = change.file.replace(/^tgui\//, "");
    const outputDir = path.join(plan.moduleRoot, "tgui/converted");
    const bunPath = this.config().get("bunPath", "bun") || "bun";
    plan.commands.push({
      title: `Dynamic TGUI smart convert ${target}`,
      file: bunPath,
      args: [
        dynamicTguiCli,
        "create-override",
        "--target",
        target,
        "--out-dir",
        outputDir,
        "--upstream-ref",
        plan.base
      ],
      cwd: this.root,
      env: {
        DYNAMIC_MODULES_HOST_ROOT: this.root,
        DYNAMIC_TGUI_ROOT: path.join(this.root, "tgui"),
        DYNAMIC_MODULES_INDEX: this.indexPath || path.join(this.root, DEFAULT_INDEX_PATH)
      }
    });
    plan.build.tgui.add("tgui/**/*.tgui.ts");
    plan.requires.add("dynamic-tgui");
    plan.notes.push(`${change.file}: queued Dynamic TGUI smart converter; it will infer AST patches and only fall back to an override when needed.`);
  }

  dynamicTguiCliPath() {
    const generatedWrapper = this.index?.generated?.tgui_cli_file
      ? this.resolveIndexPath(this.index.generated.tgui_cli_file)
      : null;
    if (generatedWrapper && fs.existsSync(generatedWrapper)) {
      return generatedWrapper;
    }
    const moduleRoot = this.index?.modules?.["dynamic-tgui"]?.root
      ? this.resolveIndexPath(this.index.modules["dynamic-tgui"].root)
      : path.join(this.root, "dynamic_modules", "installed", "dynamic-tgui");
    return moduleRoot ? path.join(moduleRoot, "tools", "cli.ts") : null;
  }

  convertDiffToPatches(plan, change) {
    const diff = this.git(["diff", "--unified=3", "--no-ext-diff", plan.base, "--", change.file]);
    const baseText = this.gitShow(plan.base, change.oldFile || change.file);
    const groups = parseUnifiedDiffGroups(diff);
    const converted = [];
    let offset = 1;
    for (const group of groups) {
      const patch = conversionGroupToPatch(change.file, group, baseText, offset);
      if (!patch) {
        plan.unsupported.push(`${change.file}: unsupported hunk near old line ${group.oldLine}.`);
        continue;
      }
      const patchFile = uniqueModulePath(plan.moduleRoot, posixJoin("patches", `${patch.id}${patchExtensionFor(change.file)}`));
      const patchPath = path.join(plan.moduleRoot, patchFile);
      plan.writes.push({ path: patchPath, content: ensureTrailingNewline(patch.content) });
      patch.file = patchFile.replace(/\\/g, "/");
      plan.patches.push(patch);
      converted.push(patch);
      offset += 1;
    }
    return converted;
  }

  gitShow(ref, file) {
    return this.git(["show", `${ref}:${file}`]);
  }

  git(args) {
    return childProcess.execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 40,
      windowsHide: true
    }).trimEnd();
  }

  writeConversionPlan(plan) {
    fs.mkdirSync(plan.moduleRoot, { recursive: true });
    if (plan.target.kind === "new" && !fs.existsSync(path.join(plan.moduleRoot, "README.md"))) {
      plan.writes.unshift({
        path: path.join(plan.moduleRoot, "README.md"),
        content: `# ${plan.target.moduleName}\n\nConverted Dynamic SS13 module scaffold.\n`
      });
    }
    plan.writes.push({ path: plan.manifestPath, content: plan.manifestText });

    for (const copy of plan.copies) {
      fs.mkdirSync(path.dirname(copy.to), { recursive: true });
      fs.copyFileSync(copy.from, copy.to);
    }
    for (const write of plan.writes) {
      fs.mkdirSync(path.dirname(write.path), { recursive: true });
      fs.writeFileSync(write.path, write.content, "utf8");
    }
    for (const command of plan.commands) {
      this.output.appendLine(`$ ${command.file} ${command.args.map(shellishQuote).join(" ")}`);
      const result = childProcess.spawnSync(command.file, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...(command.env || {}) },
        encoding: "utf8",
        windowsHide: true
      });
      plan.commandOutputs ??= [];
      plan.commandOutputs.push({
        title: command.title,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      });
      this.appendCommandOutput(result.stdout, result.stderr);
      if (result.error || result.status !== 0) {
        throw result.error || new Error(`${command.title} failed with exit code ${result.status}`);
      }
    }
  }

  showConversionReport(plan) {
    this.output.clear();
    this.output.appendLine(`Dynamic Modules conversion: ${plan.moduleId}`);
    this.output.appendLine(`Base: ${plan.base}`);
    this.output.appendLine(`Module root: ${plan.moduleRoot}`);
    this.output.appendLine("");
    for (const copy of plan.copies) {
      this.output.appendLine(`copy ${path.relative(this.root, copy.from)} -> ${path.relative(plan.moduleRoot, copy.to)}`);
    }
    for (const write of plan.writes) {
      this.output.appendLine(`write ${path.relative(plan.moduleRoot, write.path)}`);
    }
    for (const command of plan.commands) {
      this.output.appendLine(`run ${command.title}`);
    }
    if (plan.commandOutputs?.length) {
      this.output.appendLine("");
      this.output.appendLine("Command output:");
      for (const output of plan.commandOutputs) {
        this.output.appendLine(`## ${output.title}`);
        if (output.stdout) {
          this.output.append(output.stdout);
          if (!output.stdout.endsWith("\n")) {
            this.output.appendLine("");
          }
        }
        if (output.stderr) {
          this.output.append(output.stderr);
          if (!output.stderr.endsWith("\n")) {
            this.output.appendLine("");
          }
        }
      }
    }
    for (const patch of plan.patches) {
      this.output.appendLine(`patch ${patch.id}: ${patch.mode} ${patch.target_file}`);
    }
    if (plan.notes.length) {
      this.output.appendLine("");
      this.output.appendLine("Notes:");
      for (const note of plan.notes) {
        this.output.appendLine(`- ${note}`);
      }
    }
    if (plan.unsupported.length) {
      this.output.appendLine("");
      this.output.appendLine("Skipped or needs manual conversion:");
      for (const item of plan.unsupported) {
        this.output.appendLine(`- ${item}`);
      }
    }
    this.output.show(true);
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

  async focusModuleInteraction(target = {}) {
    if (!this.index) {
      vscode.window.showWarningMessage("No Dynamic Modules index found. Run Dynamic Modules: Prepare.");
      return;
    }

    try {
      await vscode.commands.executeCommand("workbench.view.extension.dynamicSs13Modules");
    } catch {
      // Older VS Code builds may not expose a container focus command.
    }

    const moduleId = target.moduleId || target.module || null;
    this.currentFileProvider.focusInteraction(target);
    this.modulesProvider.focusModule(moduleId);
    this.currentFileProvider.refresh();
    this.modulesProvider.refresh();

    const revealOptions = { select: true, focus: true, expand: true };
    if (moduleId && this.modulesTreeView) {
      const moduleElement = this.modulesProvider.findModuleElement(moduleId);
      if (moduleElement) {
        try {
          await this.modulesTreeView.reveal(moduleElement, { ...revealOptions, focus: false });
        } catch (error) {
          this.output.appendLine(`Could not reveal module ${moduleId}: ${error.message}`);
        }
      }
    }

    const interactionElement = this.currentFileProvider.findInteractionElement(target);
    if (interactionElement && this.currentFileTreeView) {
      try {
        await this.currentFileTreeView.reveal(interactionElement, revealOptions);
        return;
      } catch (error) {
        this.output.appendLine(`Could not reveal current-file interaction: ${error.message}`);
      }
    }

    if (moduleId && this.modulesTreeView) {
      const moduleElement = this.modulesProvider.findModuleElement(moduleId);
      if (moduleElement) {
        try {
          await this.modulesTreeView.reveal(moduleElement, revealOptions);
          return;
        } catch (error) {
          this.output.appendLine(`Could not reveal module ${moduleId}: ${error.message}`);
        }
      }
    }

    await this.explainCurrentFile();
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

  async restoreFolderWindow() {
    const hostRoot = this.localHostRoot();
    if (!hostRoot || !this.isHostWorkspaceRoot(hostRoot)) {
      vscode.window.showWarningMessage("No Dynamic Modules host folder is available for this window.");
      return;
    }
    await this.repairStaleLiveAuthoringWorkspace(true);
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
    this.focusedModuleId = null;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  focusModule(moduleId) {
    this.focusedModuleId = moduleId || null;
  }

  findModuleElement(moduleId) {
    if (!moduleId) {
      return null;
    }
    const modules = this.controller.index?.modules || {};
    if (!modules[moduleId]) {
      return null;
    }
    const loadOrder = this.controller.index?.load_order || Object.keys(modules);
    const offset = Math.max(0, loadOrder.indexOf(moduleId));
    return moduleItem(moduleId, modules[moduleId], offset, moduleId === this.focusedModuleId);
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
      const items = (index.load_order || []).map((moduleId, offset) => (
        moduleItem(moduleId, modules[moduleId] || {}, offset, moduleId === this.focusedModuleId)
      ));
      if (index.prepare_plugins?.length) {
        items.unshift(groupItem("Prepare plugins", "preparePlugins", index.prepare_plugins.length));
      }
      const generatedCount = Object.values(index.generated || {}).filter(Boolean).length;
      if (generatedCount) {
        items.unshift(groupItem("Generated outputs", "generatedOutputs", generatedCount));
      }
      if (index.warnings?.length) {
        items.unshift(groupItem("Warnings", "warnings", index.warnings.length));
      }
      return items;
    }

    if (element.type === "warnings") {
      return (index.warnings || []).map((warning) => infoItem(warning));
    }

    if (element.type === "preparePlugins") {
      return (index.prepare_plugins || []).map((plugin) => preparePluginTreeItem(plugin));
    }

    if (element.type === "generatedOutputs") {
      return generatedOutputItems(this.controller, index.generated || {});
    }

    if (element.type === "preparePlugin") {
      return element.children || [];
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
    if (moduleData.tgui_files?.length) {
      children.push(groupItem("TGUI overlays", "tguiFiles", moduleData.tgui_files.length, { moduleId }));
    }
    if (moduleData.asset_files?.length) {
      children.push(groupItem("Assets", "assetFiles", moduleData.asset_files.length, { moduleId }));
    }
    if (moduleData.prepare_plugins?.length) {
      children.push(groupItem("Prepare plugins", "modulePreparePlugins", moduleData.prepare_plugins.length, { moduleId }));
    }
    if (moduleData.dynamic_dm) {
      children.push(detailItem("Dynamic DM", capabilitySummary(moduleData.dynamic_dm)));
    }
    if (moduleData.dynamic_assets) {
      children.push(detailItem("Dynamic Assets", capabilitySummary(moduleData.dynamic_assets)));
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
    if (group.groupKind === "tguiFiles") {
      return (moduleData.tgui_files || []).map((filePath) => fileItem(filePath, this.controller.resolveIndexPath(filePath), "$(browser)"));
    }
    if (group.groupKind === "assetFiles") {
      return (moduleData.asset_files || []).map((filePath) => fileItem(filePath, this.controller.resolveIndexPath(filePath), "$(symbol-color)"));
    }
    if (group.groupKind === "modulePreparePlugins") {
      return (moduleData.prepare_plugins || []).map((plugin) => preparePluginTreeItem({
        module: group.moduleId,
        id: plugin.id,
        command: [plugin.command, ...(plugin.args || [])],
        description: plugin.description
      }));
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
    this.focusedInteractionKey = null;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  focusInteraction(target) {
    this.focusedInteractionKey = interactionKeyFromFocusTarget(target);
  }

  findInteractionElement(target) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return null;
    }
    const interactions = this.controller.interactionsForDocument(editor.document);
    const interaction = interactions.find((candidate) => interactionMatchesFocusTarget(candidate, target));
    return interaction ? interactionTreeItem(interaction, interactionKey(interaction) === this.focusedInteractionKey) : null;
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
      return interactions.map((interaction) => (
        interactionTreeItem(interaction, interactionKey(interaction) === this.focusedInteractionKey)
      ));
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

    const blockInteractionKeys = new Set();
    for (const block of this.controller.overrideBlocksForDocument(document, interactions)) {
      const target = this.controller.focusTargetForBlock(block);
      for (const interaction of block.interactions) {
        blockInteractionKeys.add(interactionKey(interaction));
      }
      lenses.push(new vscode.CodeLens(new vscode.Range(block.startLine, 0, block.startLine, 0), {
        title: `$(symbol-event) MODULAR OVERRIDE FROM: ${block.moduleLabel}`,
        command: "dynamicSs13Modules.focusModuleInteraction",
        arguments: [target]
      }));
      lenses.push(new vscode.CodeLens(new vscode.Range(block.afterLine, 0, block.afterLine, 0), {
        title: `$(debug-stop) END MODULAR OVERRIDE: ${block.moduleLabel}`,
        command: "dynamicSs13Modules.focusModuleInteraction",
        arguments: [target]
      }));
    }

    for (const interaction of interactions) {
      if (blockInteractionKeys.has(interactionKey(interaction))) {
        continue;
      }
      const lineNumber = Number(interaction.anchor_line);
      if (!Number.isInteger(lineNumber)) {
        continue;
      }
      const line = Math.max(0, Math.min(document.lineCount - 1, lineNumber - 1));
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: this.controller.shortInteractionLabel(interaction),
        command: "dynamicSs13Modules.focusModuleInteraction",
        arguments: [this.controller.focusTargetForInteraction(interaction)]
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

function moduleItem(moduleId, moduleData, offset, focused = false) {
  const item = new vscode.TreeItem(`${offset + 1}. ${moduleId}`, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = moduleTreeItemId(moduleId);
  item.type = "module";
  item.moduleId = moduleId;
  item.moduleData = moduleData;
  item.contextValue = "module";
  item.description = focused ? `${moduleData.version || ""} selected`.trim() : moduleData.version || "";
  item.tooltip = [
    moduleData.name || moduleId,
    moduleData.root || "",
    moduleData.source?.repo || ""
  ].filter(Boolean).join("\n");
  item.iconPath = focused
    ? new vscode.ThemeIcon("arrow-right", new vscode.ThemeColor("charts.blue"))
    : new vscode.ThemeIcon("package");
  return item;
}

function groupItem(label, groupKind, count, extra = {}) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.type = ["warnings", "preparePlugins", "generatedOutputs"].includes(groupKind) ? groupKind : "group";
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

function generatedOutputItems(controller, generated) {
  const entries = [
    ["include_file", "Generated DM include", "$(file-code)"],
    ["tests_file", "Generated test include", "$(beaker)"],
    ["config_file", "Generated config", "$(settings-gear)"],
    ["prepare_context_file", "Prepare context", "$(json)"],
    ["tgui_cli_file", "Dynamic TGUI wrapper", "$(browser)"],
    ["dynamic_dm_index_file", "Dynamic DM index", "$(symbol-class)"],
    ["dynamic_assets_index_file", "Dynamic Assets index", "$(symbol-color)"]
  ];
  return entries
    .filter(([key]) => generated[key])
    .map(([key, label, icon]) => fileItem(label, controller.resolveIndexPath(generated[key]), icon));
}

function preparePluginTreeItem(plugin) {
  const label = `${plugin.module || "module"}:${plugin.id || "prepare-plugin"}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.type = "preparePlugin";
  item.description = Array.isArray(plugin.command) ? plugin.command.join(" ") : "";
  item.tooltip = [
    label,
    plugin.description || "",
    item.description,
    plugin.output_file || ""
  ].filter(Boolean).join("\n");
  item.iconPath = new vscode.ThemeIcon("tools");
  item.children = [
    plugin.output_file && detailItem("Output", plugin.output_file),
    plugin.description && detailItem("Description", plugin.description),
    ...(plugin.warnings || []).map((warning) => detailItem("Warning", warning))
  ].filter(Boolean);
  return item;
}

function interactionTreeItem(interaction, focused = false) {
  const kind = interaction.kind === "module_patch" ? "local patch" : interaction.kind;
  const label = `${kind} ${interaction.module || "unknown"}:${interaction.id || "unknown"}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `interaction:${interactionKey(interaction)}`;
  item.type = "interaction";
  item.interaction = interaction;
  item.contextValue = "interaction";
  item.description = focused
    ? `${interaction.anchor_line ? `line ${interaction.anchor_line}` : interaction.mode || ""} selected`.trim()
    : interaction.anchor_line ? `line ${interaction.anchor_line}` : interaction.mode || "";
  item.tooltip = [
    label,
    interaction.target_file || interaction.target || "",
    interaction.output_file || interaction.source_file || ""
  ].filter(Boolean).join("\n");
  item.iconPath = focused
    ? new vscode.ThemeIcon("arrow-right", new vscode.ThemeColor("charts.blue"))
    : interactionIcon(interaction.kind);
  return item;
}

function groupIcon(kind) {
  const icons = {
    dependencies: "references",
    dmFiles: "file-code",
    testFiles: "beaker",
    tguiFiles: "browser",
    assetFiles: "symbol-color",
    modulePreparePlugins: "tools",
    preparePlugins: "tools",
    generatedOutputs: "archive",
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
    module_patch: "diff-modified",
    prepare_plugin: "tools"
  };
  return new vscode.ThemeIcon(icons[kind] || "symbol-event");
}

function capabilitySummary(value) {
  const capabilities = Array.isArray(value?.capabilities) ? value.capabilities.join(", ") : "";
  return capabilities || `api ${value?.api_version || "unknown"}`;
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

function moduleTreeItemId(moduleId) {
  return `module:${moduleId || "unknown"}`;
}

function interactionKey(interaction = {}) {
  return [
    interaction.kind || "",
    interaction.module || "",
    interaction.id || "",
    interaction.target_file || interaction.target || "",
    interaction.anchor_line || ""
  ].join("\u001f");
}

function interactionKeyFromFocusTarget(target = {}) {
  if (target.interactionKey) {
    return target.interactionKey;
  }
  return [
    target.interactionKind || target.kind || "",
    target.moduleId || target.module || "",
    target.interactionId || target.id || "",
    target.targetFile || target.target_file || target.target || "",
    target.anchorLine || target.anchor_line || ""
  ].join("\u001f");
}

function interactionMatchesFocusTarget(interaction, target = {}) {
  if (!interaction) {
    return false;
  }
  if (target.interactionKey && interactionKey(interaction) === target.interactionKey) {
    return true;
  }
  if ((target.moduleId || target.module) && interaction.module !== (target.moduleId || target.module)) {
    return false;
  }
  if ((target.interactionId || target.id) && interaction.id !== (target.interactionId || target.id)) {
    return false;
  }
  if ((target.interactionKind || target.kind) && interaction.kind !== (target.interactionKind || target.kind)) {
    return false;
  }
  const targetFile = target.targetFile || target.target_file;
  if (targetFile && interaction.target_file && comparablePath(interaction.target_file) !== comparablePath(targetFile)) {
    return false;
  }
  const anchor = target.anchorLine || target.anchor_line;
  if (anchor && Number(interaction.anchor_line) !== Number(anchor)) {
    return false;
  }
  return true;
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

function diffLineHunks(oldText, newText) {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  if (oldLines.length && oldLines[oldLines.length - 1] === "") {
    oldLines.pop();
  }
  if (newLines.length && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length;
  let newSuffix = newLines.length;
  while (oldSuffix > prefix && newSuffix > prefix && oldLines[oldSuffix - 1] === newLines[newSuffix - 1]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  if (prefix === oldLines.length && prefix === newLines.length) {
    return [];
  }

  const oldMiddle = oldLines.slice(prefix, oldSuffix);
  const newMiddle = newLines.slice(prefix, newSuffix);
  if (!oldMiddle.length || !newMiddle.length || oldMiddle.length * newMiddle.length > 200000) {
    return [{
      oldStart: prefix,
      oldEnd: oldSuffix,
      newStart: prefix,
      newEnd: newSuffix,
      removed: oldMiddle,
      added: newMiddle
    }];
  }

  return lcsDiffHunks(oldMiddle, newMiddle, prefix);
}

function lcsDiffHunks(oldLines, newLines, offset) {
  const width = newLines.length + 1;
  const table = new Array((oldLines.length + 1) * width).fill(0);
  const at = (oldIndex, newIndex) => oldIndex * width + newIndex;
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[at(oldIndex, newIndex)] = oldLines[oldIndex] === newLines[newIndex]
        ? table[at(oldIndex + 1, newIndex + 1)] + 1
        : Math.max(table[at(oldIndex + 1, newIndex)], table[at(oldIndex, newIndex + 1)]);
    }
  }

  const hunks = [];
  let oldIndex = 0;
  let newIndex = 0;
  let pending = null;
  const ensurePending = () => {
    pending ??= {
      oldStart: oldIndex + offset,
      oldEnd: oldIndex + offset,
      newStart: newIndex + offset,
      newEnd: newIndex + offset,
      removed: [],
      added: []
    };
    return pending;
  };
  const flush = () => {
    if (pending) {
      hunks.push(pending);
      pending = null;
    }
  };

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      flush();
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    if (newIndex < newLines.length && (oldIndex >= oldLines.length || table[at(oldIndex, newIndex + 1)] >= table[at(oldIndex + 1, newIndex)])) {
      const hunk = ensurePending();
      hunk.added.push(newLines[newIndex]);
      newIndex += 1;
      hunk.newEnd = newIndex + offset;
      continue;
    }
    if (oldIndex < oldLines.length) {
      const hunk = ensurePending();
      hunk.removed.push(oldLines[oldIndex]);
      oldIndex += 1;
      hunk.oldEnd = oldIndex + offset;
    }
  }
  flush();
  return hunks;
}

function interactionsForHunk(hunk, interactions) {
  const oldStartLine = hunk.oldStart + 1;
  const oldEndLine = Math.max(oldStartLine, hunk.oldEnd);
  const matching = interactions
    .filter((interaction) => {
      const anchor = Number(interaction.anchor_line);
      return Number.isInteger(anchor) && anchor >= oldStartLine - 3 && anchor <= oldEndLine + 3;
    });
  return matching.length ? matching : interactions;
}

function modulesForHunk(hunk, interactions) {
  const matching = interactionsForHunk(hunk, interactions)
    .map((interaction) => interaction.module)
    .filter(Boolean);
  const modules = matching.length
    ? matching
    : interactions.map((interaction) => interaction.module).filter(Boolean);
  return [...new Set(modules)].sort();
}

function clampLine(document, line) {
  return Math.max(0, Math.min(document.lineCount - 1, line));
}

function languageForPath(filePath) {
  if (filePath.endsWith(".dm")) {
    return "dm";
  }
  if (/\.(tsx|ts|jsx|js)$/i.test(filePath)) {
    return "typescript";
  }
  if (/\.(scss|css)$/i.test(filePath)) {
    return "css";
  }
  if (/\.json$/i.test(filePath)) {
    return "json";
  }
  if (/\.toml$/i.test(filePath)) {
    return "toml";
  }
  return "";
}

function removedGhostText(lines) {
  return lines.join("\n");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shouldOfferConversion(file) {
  const normalized = file.replace(/\\/g, "/");
  if (
    normalized.startsWith(".git/") ||
    normalized.startsWith(".dynamic_modules_build/") ||
    normalized.startsWith("dynamic_modules/") ||
    normalized.startsWith("data/logs/") ||
    normalized === "dynamic_modules.lock.json" ||
    normalized === ".gitmodules" ||
    normalized.endsWith(".dmb") ||
    normalized.endsWith(".rsc")
  ) {
    return false;
  }
  return true;
}

function conversionKindLabel(file) {
  if (isTguiSourcePath(file)) {
    return "Dynamic TGUI smart conversion";
  }
  if (isDmPath(file)) {
    return isTestDmPath(file) ? "module unit test source" : "DM source or structured patch";
  }
  if (isBinaryLikePath(file)) {
    return "Dynamic Assets contribution";
  }
  return "structured patch candidate";
}

function planHasConvertibleOutput(plan) {
  return Boolean(
    plan.commands.length ||
    plan.writes.length ||
    plan.copies.length ||
    plan.patches.length ||
    Object.values(plan.build).some((values) => values.size)
  );
}

function isDmPath(file) {
  return file.replace(/\\/g, "/").endsWith(".dm");
}

function isAuthorablePath(file) {
  const normalized = file.replace(/\\/g, "/");
  return !normalized.startsWith(".dynamic_modules_build/") &&
    !normalized.startsWith(".dynamic_modules_authoring/") &&
    !normalized.endsWith(".dmb") &&
    !normalized.endsWith(".rsc") &&
    (isDmPath(normalized) || isTguiSourcePath(normalized) || isBinaryLikePath(normalized) || /\.(json|toml|txt|md|css|scss|tsx?|jsx?)$/i.test(normalized));
}

function authoringKind(file) {
  if (isDmPath(file)) {
    return "dm";
  }
  if (isTguiSourcePath(file)) {
    return "tgui";
  }
  if (isBinaryLikePath(file)) {
    return "asset";
  }
  return "text";
}

function parseDynamicDmConvertedTargets(stdout) {
  const targets = [];
  for (const line of (stdout || "").split(/\r?\n/)) {
    const match = /^CONVERTED (.+?): /.exec(line);
    if (match) {
      targets.push(match[1]);
    }
  }
  return targets;
}

function gitDirForRoot(root) {
  if (!root) {
    return null;
  }
  const dotGit = path.join(root, ".git");
  if (!fs.existsSync(dotGit)) {
    return null;
  }
  const stats = fs.statSync(dotGit);
  if (stats.isDirectory()) {
    return dotGit;
  }
  if (!stats.isFile()) {
    return null;
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
  if (!match) {
    return null;
  }
  return path.resolve(root, match[1]);
}

function isTestDmPath(file) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("tests/") || normalized.includes("/unit_tests/") || normalized.includes("/unit_test");
}

function isTguiSourcePath(file) {
  const normalized = file.replace(/\\/g, "/");
  return normalized.startsWith("tgui/") && /\.(tsx?|jsx?|scss|css)$/.test(normalized);
}

function isBinaryLikePath(file) {
  return /\.(dmi|png|jpg|jpeg|gif|webp|ogg|wav|mp3|mid|midi|ttf|otf|woff2?|ico|rsc|dmb)$/i.test(file);
}

function patchExtensionFor(file) {
  if (file.endsWith(".dm")) {
    return ".dm";
  }
  const ext = path.posix.extname(file.replace(/\\/g, "/"));
  return ext || ".txt";
}

function parseUnifiedDiffGroups(diff) {
  const groups = [];
  let oldLine = 0;
  let pending = null;
  let beforeContext = null;

  const flush = (afterContext = null) => {
    if (!pending) {
      return;
    }
    pending.afterContext = afterContext;
    groups.push(pending);
    pending = null;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flush();
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
      oldLine = match ? Number(match[1]) : 0;
      beforeContext = null;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff --git") || line.startsWith("index ")) {
      continue;
    }
    if (!line || line.startsWith("\\ No newline")) {
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      const context = { text, oldLine };
      flush(context);
      beforeContext = context;
      oldLine += 1;
      continue;
    }
    if (marker === "-") {
      pending ??= { removed: [], added: [], beforeContext, oldLine };
      pending.removed.push({ text, oldLine });
      oldLine += 1;
      continue;
    }
    if (marker === "+") {
      pending ??= { removed: [], added: [], beforeContext, oldLine };
      pending.added.push(text);
    }
  }
  flush();
  return groups;
}

function conversionGroupToPatch(file, group, baseText, offset) {
  const safeBase = safeIdentifier(file).slice(0, 70) || "change";
  const id = `${safeBase}-${offset}`;
  if (!group.removed.length && group.added.length) {
    if (group.beforeContext) {
      return {
        id,
        target_file: file,
        mode: "insert_after",
        anchor: group.beforeContext.text,
        occurrence: occurrenceForLine(baseText, group.beforeContext.text, group.beforeContext.oldLine),
        risk: "converted_branch_change",
        description: "Converted from branch diff by the Dynamic Modules VS Code extension.",
        content: group.added.join("\n")
      };
    }
    if (group.afterContext) {
      return {
        id,
        target_file: file,
        mode: "insert_before",
        anchor: group.afterContext.text,
        occurrence: occurrenceForLine(baseText, group.afterContext.text, group.afterContext.oldLine),
        risk: "converted_branch_change",
        description: "Converted from branch diff by the Dynamic Modules VS Code extension.",
        content: group.added.join("\n")
      };
    }
    return null;
  }

  if (group.removed.length === 1 && group.added.length) {
    const removed = group.removed[0];
    return {
      id,
      target_file: file,
      mode: "replace",
      anchor: removed.text,
      occurrence: occurrenceForLine(baseText, removed.text, removed.oldLine),
      risk: "converted_branch_change",
      description: "Converted from branch diff by the Dynamic Modules VS Code extension.",
      content: group.added.join("\n")
    };
  }

  return null;
}

function occurrenceForLine(source, anchor, oldLine) {
  const lines = source.split(/\r?\n/);
  let count = 0;
  for (let index = 0; index < Math.min(lines.length, oldLine); index += 1) {
    if (lines[index].includes(anchor)) {
      count += 1;
    }
  }
  return Math.max(1, count);
}

function renderNewModuleManifest(plan) {
  const lines = [
    `id = ${tomlString(plan.moduleId)}`,
    `name = ${tomlString(plan.target.moduleName)}`,
    'version = "0.1.0"',
    'module_api = "1"',
    `description = ${tomlString(`Converted branch changes from ${plan.base}.`)}`,
    "",
    "[compat]",
    'target = "tgstation"',
    'minimum_dynamic_modules = "1.0.0"',
    ""
  ];
  if (plan.requires.size) {
    lines.push("[load]");
    lines.push(`requires = ${tomlArray([...plan.requires].sort())}`);
    lines.push("");
  }
  lines.push("[build]");
  lines.push(`dm_files = ${tomlArray([...plan.build.dm_files].sort())}`);
  lines.push(`test_files = ${tomlArray([...plan.build.test_files].sort())}`);
  if (plan.build.assets.size) {
    lines.push(`assets = ${tomlArray([...plan.build.assets].sort())}`);
  }
  if (plan.build.tgui.size) {
    lines.push(`tgui = ${tomlArray([...plan.build.tgui].sort())}`);
  }
  lines.push("");
  lines.push(...renderPatchBlocks(plan.patches));
  return ensureTrailingNewline(lines.join("\n"));
}

function updateExistingManifest(manifestPath, plan) {
  let text = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
  if (!text.trim()) {
    return renderNewModuleManifest(plan);
  }
  if (plan.requires.size) {
    text = ensureTomlArrayValues(text, "load", "requires", [...plan.requires].sort());
  }
  for (const [key, values] of Object.entries(plan.build)) {
    const items = [...values].sort();
    if (items.length) {
      text = ensureTomlArrayValues(text, "build", key, items);
    }
  }
  const patchBlocks = renderPatchBlocks(plan.patches);
  if (patchBlocks.length) {
    text = `${text.trimEnd()}\n\n# Converted by Dynamic Modules VS Code extension\n${patchBlocks.join("\n")}\n`;
  }
  return ensureTrailingNewline(text);
}

function ensureTomlArrayValues(text, tableName, key, values) {
  if (!values.length) {
    return text;
  }
  const tableHeader = `[${tableName}]`;
  const tableRegex = new RegExp(`(^|\\n)\\[${escapeRegExp(tableName)}\\]\\n`, "m");
  const tableMatch = tableRegex.exec(text);
  if (!tableMatch) {
    return `${text.trimEnd()}\n\n${tableHeader}\n${key} = ${tomlArray(values)}\n`;
  }

  const tableStart = tableMatch.index + tableMatch[0].length;
  const nextTableIndex = text.slice(tableStart).search(/\n\[/);
  const tableEnd = nextTableIndex === -1 ? text.length : tableStart + nextTableIndex + 1;
  const before = text.slice(0, tableStart);
  let tableBody = text.slice(tableStart, tableEnd);
  const after = text.slice(tableEnd);
  const keyRegex = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[([^\\]]*)\\]`, "m");
  const keyMatch = keyRegex.exec(tableBody);
  if (!keyMatch) {
    tableBody = `${key} = ${tomlArray(values)}\n${tableBody}`;
    return before + tableBody + after;
  }

  const existing = keyMatch[1]
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const merged = [...new Set([...existing, ...values])].sort();
  tableBody = tableBody.replace(keyRegex, `${key} = ${tomlArray(merged)}`);
  return before + tableBody + after;
}

function renderPatchBlocks(patches) {
  return patches.flatMap((patch) => [
    "[[patches]]",
    `id = ${tomlString(patch.id)}`,
    `target_file = ${tomlString(patch.target_file)}`,
    `mode = ${tomlString(patch.mode)}`,
    `anchor = ${tomlString(patch.anchor)}`,
    ...(patch.end_anchor ? [`end_anchor = ${tomlString(patch.end_anchor)}`] : []),
    `file = ${tomlString(patch.file)}`,
    `occurrence = ${patch.occurrence}`,
    `risk = ${tomlString(patch.risk)}`,
    `description = ${tomlString(patch.description)}`,
    ""
  ]);
}

function titleCaseModuleId(moduleId) {
  return moduleId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function renderAuthoringModuleManifest(target) {
  return ensureTrailingNewline([
    `id = ${tomlString(target.moduleId)}`,
    `name = ${tomlString(target.moduleName)}`,
    'version = "0.1.0"',
    'module_api = "1"',
    'description = "Deconverted from a Dynamic Modules authoring workspace."',
    "",
    "[load]",
    "requires = []",
    "",
    "[compat]",
    'target = "tgstation"',
    'minimum_dynamic_modules = "1.0.0"',
    "",
    "[build]",
    "dm_files = []",
    "test_files = []",
    "assets = []",
    "tgui = []",
    ""
  ].join("\n"));
}

function uniqueModulePath(moduleRoot, relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  let candidate = normalized;
  const ext = path.posix.extname(normalized);
  const base = ext ? normalized.slice(0, -ext.length) : normalized;
  let index = 2;
  while (fs.existsSync(path.join(moduleRoot, candidate))) {
    candidate = `${base}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

function authoringSessionId() {
  const now = new Date();
  const stamp = now.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "-");
  return stamp;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeIdentifier(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { activate, deactivate };
