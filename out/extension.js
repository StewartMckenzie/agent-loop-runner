"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = require("path");
const vscode = require("vscode");
const PROMPTS_ROOT = '.ralph/prompts';
const STATUS_ROOT = '.ralph/status';
const STATUS_GLOB = '**/.ralph/status/**/*.status.md';
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('ralphLoopRunner.open', () => RalphLoopRunnerPanel.createOrShow(context)));
}
function deactivate() { }
class RalphLoopRunnerPanel {
    static currentPanel;
    panel;
    context;
    disposables = [];
    jobs = [];
    runId = '';
    running = false;
    // Queue
    queue = [];
    // featureName -> jobIdx
    featureToJob = new Map();
    // Watchers
    progressWatcher;
    specWatcher;
    reqWatcher;
    statusWatcher;
    constructor(panel, context) {
        this.panel = panel;
        this.context = context;
        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [context.extensionUri],
        };
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), undefined, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.initWatchers();
        this.postState();
    }
    static createOrShow(context) {
        const column = vscode.ViewColumn.One;
        if (RalphLoopRunnerPanel.currentPanel) {
            RalphLoopRunnerPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('ralphLoopRunner', 'Ralph Loop Runner', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        RalphLoopRunnerPanel.currentPanel = new RalphLoopRunnerPanel(panel, context);
    }
    dispose() {
        RalphLoopRunnerPanel.currentPanel = undefined;
        this.progressWatcher?.dispose();
        this.specWatcher?.dispose();
        this.reqWatcher?.dispose();
        this.statusWatcher?.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            try {
                d?.dispose();
            }
            catch { }
        }
    }
    getConfig() {
        const cfg = vscode.workspace.getConfiguration('ralphLoopRunner');
        return {
            maxLoopsPerUrl: clampInt(cfg.get('maxLoopsPerUrl', 3), 1, 20),
            featureMapWindowMs: clampInt(cfg.get('featureMapWindowMs', 120000), 1000, 3600000),
            // Where your existing prompt template lives (workspace-relative)
            promptTemplatePath: cfg.get('promptTemplatePath', '.github/prompts/basePrompt.md'),
            // Agent to route prompts to (must match a .github/agents/<name>.agent.md)
            agentName: cfg.get('agentName', 'PlaywrightPlanning'),
            // Safety-net timeout per job (ms). 0 = no timeout (default).
            perJobTimeoutMs: clampInt(cfg.get('perJobTimeoutMs', 0), 0, 86400000),
            // Watcher globs (workspace-relative)
            progressGlob: cfg.get('progressGlob', '**/src/IntegrationTests/WebsitesExtension.E2ETests/tmp/progress-tracking/*-progress.md'),
            specGlob: cfg.get('specGlob', '**/src/IntegrationTests/WebsitesExtension.E2ETests/Tests/**/Agent-Based/*/*.spec.ts'),
            requirementsGlob: cfg.get('requirementsGlob', '**/src/IntegrationTests/WebsitesExtension.E2ETests/Tests/**/Agent-Based/**/*-requirements.md'),
        };
    }
    initWatchers() {
        const cfg = this.getConfig();
        const progressWatcher = vscode.workspace.createFileSystemWatcher(cfg.progressGlob);
        const specWatcher = vscode.workspace.createFileSystemWatcher(cfg.specGlob);
        const reqWatcher = vscode.workspace.createFileSystemWatcher(cfg.requirementsGlob);
        const statusWatcher = vscode.workspace.createFileSystemWatcher(STATUS_GLOB);
        progressWatcher.onDidCreate(uri => this.onProgressFileEvent(uri));
        progressWatcher.onDidChange(uri => this.onProgressFileEvent(uri));
        specWatcher.onDidCreate(uri => this.onSpecFileEvent(uri));
        specWatcher.onDidChange(uri => this.onSpecFileEvent(uri));
        reqWatcher.onDidCreate(uri => this.onReqFileEvent(uri));
        reqWatcher.onDidChange(uri => this.onReqFileEvent(uri));
        statusWatcher.onDidCreate(uri => this.onStatusFileEvent(uri));
        statusWatcher.onDidChange(uri => this.onStatusFileEvent(uri));
        this.progressWatcher = progressWatcher;
        this.specWatcher = specWatcher;
        this.reqWatcher = reqWatcher;
        this.statusWatcher = statusWatcher;
        this.disposables.push(progressWatcher, specWatcher, reqWatcher, statusWatcher);
    }
    reinitWatchers() {
        this.progressWatcher?.dispose();
        this.specWatcher?.dispose();
        this.reqWatcher?.dispose();
        this.statusWatcher?.dispose();
        this.initWatchers();
    }
    async onMessage(msg) {
        switch (msg?.type) {
            case 'loadAndRun': {
                // Reject new runs while one is already in progress to avoid
                // corrupting the active job list.
                if (this.running)
                    return;
                const pairs = (msg?.pairs ?? [])
                    .map((p) => ({
                    url: String(p?.url ?? '').trim(),
                    prompt: String(p?.prompt ?? '').trim(),
                }))
                    .filter((p) => p.url && looksLikeUrl(p.url));
                // Deduplicate by URL, keeping the first occurrence
                const seen = new Set();
                const dedupedPairs = [];
                for (const p of pairs) {
                    if (!seen.has(p.url)) {
                        seen.add(p.url);
                        dedupedPairs.push(p);
                    }
                }
                const globalMaxLoops = msg?.globalMaxLoops;
                this.buildJobs(dedupedPairs, globalMaxLoops);
                if (!this.jobs.length)
                    return;
                this.running = true;
                this.runId = makeRunId();
                this.queue = this.jobs.map((_, i) => i);
                this.featureToJob.clear();
                const { maxLoopsPerUrl: maxLoops } = this.getConfig();
                this.jobs = this.jobs.map(j => ({
                    ...j,
                    runId: this.runId,
                    maxLoops: j.maxLoops || maxLoops,
                    attemptsUsed: 0,
                    status: 'Queued',
                    stopped: false,
                    failureMessage: undefined,
                    featureName: undefined,
                    progressFile: undefined,
                    specFile: undefined,
                    requirementsFile: undefined,
                    finalStatus: undefined,
                    lastRun: undefined,
                    reason: undefined,
                    startedAt: undefined,
                    mappedAt: undefined,
                    promptPath: undefined,
                }));
                this.postState();
                await this.ensureStatusDir();
                void this.pumpQueue();
                return;
            }
            case 'cancelJob': {
                const idx = msg?.jobIndex;
                const job = this.jobs[idx];
                if (job && (job.status === 'Running' || job.status === 'Planning')) {
                    this.jobs[idx] = {
                        ...job,
                        status: 'Failed',
                        stopped: true,
                        failureMessage: 'Manually cancelled by user.',
                        finalStatus: 'FAIL',
                    };
                    this.postState();
                    // Cancel the active chat response — equivalent to clicking
                    // the stop button in the chat panel
                    try {
                        await vscode.commands.executeCommand('workbench.action.chat.cancel');
                    }
                    catch {
                        // Best-effort
                    }
                }
                return;
            }
            case 'stop': {
                // Cancel the active chat response before stopping the runner
                try {
                    await vscode.commands.executeCommand('workbench.action.chat.cancel');
                }
                catch {
                    // Best-effort
                }
                this.running = false;
                this.queue = [];
                for (const j of this.jobs) {
                    if (j.status === 'Queued')
                        j.status = 'Stopped';
                    j.stopped = true;
                }
                this.postState();
                return;
            }
            case 'openProgress': {
                const job = this.jobs[msg?.jobIndex];
                if (job?.progressFile) {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(job.progressFile));
                }
                return;
            }
            case 'setMaxLoops': {
                const idx = msg?.jobIndex;
                const raw = msg?.value;
                if (raw === undefined || raw === null || Number.isNaN(Number(raw)))
                    return;
                const value = clampInt(Number(raw), 1, 20);
                const job = this.jobs[idx];
                if (job) {
                    this.jobs[idx] = { ...job, maxLoops: value };
                    this.postState();
                }
                return;
            }
            case 'setAllMaxLoops': {
                const raw = msg?.value;
                if (raw === undefined || raw === null || Number.isNaN(Number(raw)))
                    return;
                const value = clampInt(Number(raw), 1, 20);
                for (let i = 0; i < this.jobs.length; i++) {
                    this.jobs[i] = { ...this.jobs[i], maxLoops: value };
                }
                this.postState();
                return;
            }
            case 'openArtifacts': {
                const job = this.jobs[msg?.jobIndex];
                const folder = job?.specFile ? path.dirname(job.specFile) : undefined;
                if (folder) {
                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
                }
                return;
            }
            case 'setGlobs': {
                const progressGlob = String(msg?.progressGlob ?? '').trim();
                const specGlob = String(msg?.specGlob ?? '').trim();
                const requirementsGlob = String(msg?.requirementsGlob ?? '').trim();
                const cfg = vscode.workspace.getConfiguration('ralphLoopRunner');
                if (progressGlob)
                    await cfg.update('progressGlob', progressGlob, vscode.ConfigurationTarget.Workspace);
                if (specGlob)
                    await cfg.update('specGlob', specGlob, vscode.ConfigurationTarget.Workspace);
                if (requirementsGlob)
                    await cfg.update('requirementsGlob', requirementsGlob, vscode.ConfigurationTarget.Workspace);
                this.reinitWatchers();
                this.postState();
                return;
            }
            default:
                return;
        }
    }
    buildJobs(pairs, globalMaxLoops) {
        const { maxLoopsPerUrl } = this.getConfig();
        const loops = globalMaxLoops ?? maxLoopsPerUrl;
        this.jobs = pairs.map((pair, idx0) => {
            const idx = idx0 + 1;
            return {
                index: idx,
                indexLabel: String(idx).padStart(3, '0'),
                url: pair.url,
                shortUrl: shortenUrl(pair.url),
                customPrompt: pair.prompt || undefined,
                status: 'Queued',
                runId: '',
                maxLoops: loops,
                attemptsUsed: 0,
            };
        });
    }
    async pumpQueue() {
        while (this.running && this.queue.length) {
            const jobIdx = this.queue.shift();
            const job = this.jobs[jobIdx];
            if (!job || job.stopped)
                continue;
            await this.runJob(jobIdx);
            this.postState();
        }
        this.running = false;
        this.postState();
    }
    async runJob(jobIdx) {
        const job = this.jobs[jobIdx];
        if (!job)
            return;
        const maxAttempts = job.maxLoops;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // Re-read from this.jobs each iteration so stop mutations are visible
            const current = this.jobs[jobIdx];
            if (current?.stopped || !this.running)
                return;
            try {
                // Delete stale status file before each attempt so the poller
                // doesn't immediately re-read a FAIL from the previous attempt.
                await this.deleteStatusFile(jobIdx);
                this.jobs[jobIdx] = {
                    ...this.jobs[jobIdx],
                    status: attempt === 1 ? 'Planning' : 'Running',
                    startedAt: Date.now(),
                    attemptsUsed: attempt,
                    // Reset per-attempt state
                    finalStatus: undefined,
                    failureMessage: undefined,
                };
                this.postState();
                const promptUri = await this.writePromptFile(jobIdx, attempt);
                this.jobs[jobIdx] = { ...this.jobs[jobIdx], promptPath: promptUri.fsPath, status: 'Running' };
                this.postState();
                await this.sendPromptToChat(jobIdx, promptUri);
                // Wait for the agent to complete (watcher + polling driven)
                const terminalStatus = await this.waitForTerminalStatus(jobIdx);
                // If succeeded, we're done
                if (terminalStatus === 'Done')
                    return;
                // If failed and we have more attempts, reset for retry
                if (terminalStatus === 'Failed' && attempt < maxAttempts) {
                    this.jobs[jobIdx] = {
                        ...this.jobs[jobIdx],
                        status: 'Queued',
                        failureMessage: `Attempt ${attempt} failed, retrying...`,
                    };
                    this.postState();
                    await delay(1000); // Brief pause between retries
                    continue;
                }
                // Final attempt failed or stopped — leave as-is
                return;
            }
            catch (e) {
                const msg = e?.message ? String(e.message) : String(e);
                if (attempt < maxAttempts) {
                    this.jobs[jobIdx] = {
                        ...this.jobs[jobIdx],
                        status: 'Queued',
                        attemptsUsed: attempt,
                        failureMessage: `Attempt ${attempt} error: ${msg}. Retrying...`,
                    };
                    this.postState();
                    await delay(1000);
                    continue;
                }
                // Final attempt
                this.jobs[jobIdx] = {
                    ...this.jobs[jobIdx],
                    status: 'Failed',
                    failureMessage: msg,
                    finalStatus: 'FAIL',
                    attemptsUsed: attempt,
                };
                this.postState();
                return;
            }
        }
    }
    /**
     * Deletes the status file for a job so stale FAIL results from a previous
     * attempt don't immediately poison the next retry.
     */
    async deleteStatusFile(jobIdx) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            return;
        const job = this.jobs[jobIdx];
        if (!job || !job.runId)
            return;
        const statusUri = vscode.Uri.joinPath(ws.uri, STATUS_ROOT, job.runId, `${job.indexLabel}.status.md`);
        try {
            await vscode.workspace.fs.delete(statusUri);
        }
        catch {
            // File doesn't exist yet — that's fine on attempt 1
        }
    }
    /**
     * Writes a per-job prompt file to .ralph/prompts/<runId>/<index>-attempt<N>.prompt.md
     * by reading your existing template prompt from .github/prompts/ and injecting variables.
     *
     * Template supports tokens:
     *   {{URL}}, {{RunId}}, {{Item}}, {{MaxLoopsPerUrl}}, {{Attempt}}
     */
    async writePromptFile(jobIdx, attempt = 1) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            throw new Error('No workspace folder open.');
        const job = this.jobs[jobIdx];
        const cfg = this.getConfig();
        // Output prompt (what we actually run)
        const promptsDir = vscode.Uri.joinPath(ws.uri, PROMPTS_ROOT, this.runId);
        const filename = attempt === 1 ? `${job.indexLabel}.prompt.md` : `${job.indexLabel}-attempt${attempt}.prompt.md`;
        const outPromptUri = vscode.Uri.joinPath(promptsDir, filename);
        await vscode.workspace.fs.createDirectory(promptsDir);
        // Use per-job custom prompt if provided, otherwise read from template file
        let strippedTemplate;
        if (job.customPrompt) {
            strippedTemplate = stripFrontMatter(job.customPrompt);
        }
        else {
            const templateRelPath = cfg.promptTemplatePath;
            const templateUri = vscode.Uri.joinPath(ws.uri, templateRelPath);
            let templateText;
            try {
                const data = await vscode.workspace.fs.readFile(templateUri);
                templateText = Buffer.from(data).toString('utf8');
            }
            catch (e) {
                throw new Error(`Could not read prompt template at "${templateRelPath}". ${e?.message ?? e}`);
            }
            strippedTemplate = stripFrontMatter(templateText);
        }
        // Build front matter + RunId/Item/Attempt context
        // NOTE: The custom agent is selected via the `mode` parameter in
        // workbench.action.chat.open, NOT via @mention in the body.
        const header = `---
mode: agent
---

RunId: ${this.runId}
Item: ${job.indexLabel}
URL: ${job.url}
Attempt: ${attempt}
MaxLoopsPerUrl: ${job.maxLoops}

`;
        // Inject vars into template body
        const injectedBody = injectTemplate(strippedTemplate, {
            URL: job.url,
            RunId: this.runId,
            Item: job.indexLabel,
            Attempt: String(attempt),
            MaxLoopsPerUrl: String(job.maxLoops),
        });
        // On retries, append context from the previous attempt so the agent
        // can pick up where it left off instead of starting blind.
        let retryContext = '';
        if (attempt > 1) {
            const parts = ['', '---', `## Previous Attempt Context (attempt ${attempt - 1} of ${job.maxLoops})`, ''];
            if (job.failureMessage) {
                parts.push(`**Failure reason**: ${job.failureMessage}`);
            }
            if (job.reason) {
                parts.push(`**Status reason**: ${job.reason}`);
            }
            if (job.progressFile) {
                parts.push(`**Progress file** (may contain useful locators/context): ${job.progressFile}`);
            }
            if (job.specFile) {
                parts.push(`**Existing spec file** (check before regenerating): ${job.specFile}`);
            }
            if (job.requirementsFile) {
                parts.push(`**Requirements file**: ${job.requirementsFile}`);
            }
            parts.push('');
            parts.push('Review the artifacts above before starting from scratch. Fix the failing spec if it exists rather than regenerating.');
            parts.push('');
            retryContext = parts.join('\n');
        }
        const finalText = header + injectedBody + retryContext;
        await vscode.workspace.fs.writeFile(outPromptUri, Buffer.from(finalText, 'utf8'));
        return outPromptUri;
    }
    /**
     * Sends the prompt to the VS Code chat panel, with the configured custom
     * agent selected as the active chat mode.
     *
     * `workbench.action.chat.open` accepts a `mode` parameter that maps to
     * a custom agent name (from `.github/agents/<name>.agent.md`).  Passing
     * `mode: 'PlaywrightPlanning'` selects that agent directly — no @mention
     * needed.  The command also accepts `isPartialQuery: false` to auto-submit.
     */
    async sendPromptToChat(_jobIdx, promptUri) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            throw new Error('No workspace folder open.');
        // Read the generated prompt file content
        const data = await vscode.workspace.fs.readFile(promptUri);
        const promptText = Buffer.from(data).toString('utf8');
        // Strip the YAML front matter — the chat panel doesn't use it
        const body = stripFrontMatter(promptText).trim();
        const cfg = this.getConfig();
        // Use the custom agent name as the chat mode, falling back to 'agent'
        const chatMode = cfg.agentName || 'agent';
        // Always open a NEW chat session first so each URL gets its own window.
        try {
            await vscode.commands.executeCommand('workbench.action.chat.newChat');
            await delay(400);
        }
        catch {
            // Best-effort — newChat may not exist in some builds
        }
        // ── Approach 1 ── auto-submit with custom agent selected via `mode` ──
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: body,
                isPartialQuery: false,
                mode: chatMode,
            });
            return;
        }
        catch {
            // Fall through — mode name might not resolve
        }
        // ── Approach 2 ── fill + manual submit (for older VS Code builds) ──
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: body,
                isPartialQuery: true,
                mode: chatMode,
            });
            await delay(400);
            await vscode.commands.executeCommand('workbench.action.chat.acceptInput');
            return;
        }
        catch {
            // Fall through
        }
        // ── Approach 3 ── generic agent mode (no custom agent) ──
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: body,
                isPartialQuery: false,
                mode: 'agent',
            });
            return;
        }
        catch {
            // Fall through
        }
        throw new Error('Failed to send prompt to chat. None of the known VS Code chat commands worked. ' +
            'Make sure you are running VS Code 1.95+ with GitHub Copilot Chat enabled.');
    }
    async waitForTerminalStatus(jobIdx) {
        // The loop exits when: the status file arrives (PASS/FAIL), the job
        // is cancelled/stopped by the user, this.running becomes false, or
        // the per-job timeout is exceeded (if configured).
        const { perJobTimeoutMs } = this.getConfig();
        const waitStart = Date.now();
        while (this.running) {
            const job = this.jobs[jobIdx];
            if (!job)
                return 'Failed';
            if (job.status === 'Done' || job.status === 'Failed' || job.status === 'Stopped')
                return job.status;
            // Safety-net timeout: if configured (> 0), fail the job if the
            // agent hasn't produced a status file within the window.
            if (perJobTimeoutMs > 0 && Date.now() - waitStart > perJobTimeoutMs) {
                this.jobs[jobIdx] = {
                    ...this.jobs[jobIdx],
                    status: 'Failed',
                    failureMessage: `Timed out after ${Math.round(perJobTimeoutMs / 1000)}s waiting for agent status file.`,
                    finalStatus: 'FAIL',
                };
                this.postState();
                return 'Failed';
            }
            // Poll the status file as a safety net (in case watcher events are missed)
            await this.pollStatusFile(jobIdx);
            {
                const updated = this.jobs[jobIdx];
                if (updated.status === 'Done' || updated.status === 'Failed')
                    return updated.status;
            }
            await delay(2000);
        }
        return 'Stopped';
    }
    async onProgressFileEvent(uri) {
        await this.refreshFromProgressFile(uri.fsPath);
    }
    async refreshFromProgressFile(progressPath) {
        const featureName = inferFeatureNameFromProgressPath(progressPath);
        if (!featureName)
            return;
        // Map progress file to a running job if not mapped
        if (!this.featureToJob.has(featureName)) {
            const mappedJobIdx = this.mapFeatureToMostRecentUnmappedRunningJob(featureName);
            if (mappedJobIdx === undefined)
                return;
            this.featureToJob.set(featureName, mappedJobIdx);
            const j = this.jobs[mappedJobIdx];
            this.jobs[mappedJobIdx] = { ...j, featureName, progressFile: progressPath, mappedAt: Date.now() };
            this.postState();
        }
        // NOTE: Completion detection relies on .ralph/status/ files written by
        // the PlaywrightCoding agent (RALPH_STATUS: PASS|FAIL).  The progress
        // file is only used for feature-name → job mapping above.
    }
    mapFeatureToMostRecentUnmappedRunningJob(_featureName) {
        const { featureMapWindowMs } = this.getConfig();
        const now = Date.now();
        let bestIdx;
        let bestStart = -1;
        for (let i = 0; i < this.jobs.length; i++) {
            const j = this.jobs[i];
            if (j.featureName)
                continue;
            if (j.runId !== this.runId)
                continue; // Skip jobs from previous runs
            if (j.status !== 'Running' && j.status !== 'Planning')
                continue;
            if (!j.startedAt)
                continue;
            const age = now - j.startedAt;
            if (age > featureMapWindowMs)
                continue;
            if (j.startedAt > bestStart) {
                bestStart = j.startedAt;
                bestIdx = i;
            }
        }
        return bestIdx;
    }
    async onSpecFileEvent(uri) {
        const specPath = uri.fsPath;
        const featureName = inferFeatureNameFromSpecPath(specPath);
        if (!featureName)
            return;
        const jobIdx = this.featureToJob.get(featureName);
        if (jobIdx === undefined)
            return;
        this.jobs[jobIdx] = { ...this.jobs[jobIdx], specFile: specPath };
        this.postState();
    }
    async onReqFileEvent(uri) {
        const reqPath = uri.fsPath;
        const featureName = inferFeatureNameFromRequirementsPath(reqPath);
        if (!featureName)
            return;
        const jobIdx = this.featureToJob.get(featureName);
        if (jobIdx === undefined)
            return;
        this.jobs[jobIdx] = { ...this.jobs[jobIdx], requirementsFile: reqPath };
        this.postState();
    }
    /**
     * Watches for .ralph/status/<RunId>/<Item>.status.md files written by the
     * PlaywrightCoding agent. Parses RALPH_STATUS: PASS|FAIL and maps back to
     * the corresponding job by matching the Item label (e.g. "001") in the filename.
     */
    async onStatusFileEvent(uri) {
        const statusPath = uri.fsPath;
        let content;
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            content = Buffer.from(data).toString('utf8');
        }
        catch {
            return;
        }
        // Extract <Item> from filename like 001.status.md
        const base = path.basename(statusPath);
        const itemMatch = base.match(/^(\d+)\.status\.md$/i);
        if (!itemMatch)
            return;
        const itemLabel = itemMatch[1]; // e.g. "001"
        // Find the job that matches this Item label AND the current runId
        // (status path should be under .ralph/status/<runId>/)
        const jobIdx = this.jobs.findIndex(j => j.indexLabel === itemLabel && j.runId === this.runId);
        if (jobIdx < 0)
            return;
        const job = this.jobs[jobIdx];
        // Parse the status block
        const statusMarkers = parseStatusFile(content);
        if (!statusMarkers.ralphStatus)
            return;
        const finalStatus = statusMarkers.ralphStatus;
        const status = finalStatus === 'PASS' ? 'Done' : 'Failed';
        const featureName = statusMarkers.featureName || job.featureName;
        const reason = statusMarkers.reason || statusMarkers.summary || job.reason;
        this.jobs[jobIdx] = {
            ...job,
            status,
            finalStatus,
            featureName,
            reason,
            specFile: statusMarkers.specPath || job.specFile,
        };
        this.postState();
    }
    /**
     * Creates the .ralph/status/<runId>/ directory so the agent can write status files there.
     */
    async ensureStatusDir() {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            return;
        const statusDir = vscode.Uri.joinPath(ws.uri, STATUS_ROOT, this.runId);
        try {
            await vscode.workspace.fs.createDirectory(statusDir);
        }
        catch {
            // Directory may already exist
        }
    }
    /**
     * Directly reads the status file for a job as a safety net (in case watcher events are missed).
     */
    async pollStatusFile(jobIdx) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            return;
        const job = this.jobs[jobIdx];
        if (!job || !job.runId)
            return;
        const statusUri = vscode.Uri.joinPath(ws.uri, STATUS_ROOT, job.runId, `${job.indexLabel}.status.md`);
        try {
            const data = await vscode.workspace.fs.readFile(statusUri);
            const content = Buffer.from(data).toString('utf8');
            const statusMarkers = parseStatusFile(content);
            if (!statusMarkers.ralphStatus)
                return;
            const finalStatus = statusMarkers.ralphStatus;
            const status = finalStatus === 'PASS' ? 'Done' : 'Failed';
            this.jobs[jobIdx] = {
                ...job,
                status,
                finalStatus,
                featureName: statusMarkers.featureName || job.featureName,
                reason: statusMarkers.reason || statusMarkers.summary || job.reason,
                specFile: statusMarkers.specPath || job.specFile,
            };
            this.postState();
        }
        catch {
            // File doesn't exist yet — that's normal
        }
    }
    postState() {
        this.panel.webview.postMessage({
            type: 'state',
            running: this.running,
            runId: this.runId,
            config: this.getConfig(),
            jobs: this.jobs,
            queuedCount: this.queue.length,
        });
    }
    getHtmlForWebview() {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe WPC, Segoe UI, sans-serif; padding: 12px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    button { padding: 6px 10px; }
    .muted { opacity: 0.8; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border-bottom: 1px solid rgba(127,127,127,0.35); padding: 6px 8px; text-align: left; vertical-align: top; }
    th { font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.35); font-size: 12px; }
    .actions button { margin-right: 6px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }

    /* Paired input rows */
    #inputRows { margin: 10px 0; }
    .input-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; }
    .input-row .row-num { min-width: 24px; padding-top: 6px; font-weight: 600; font-size: 13px; text-align: right; }
    .input-row input.url-field { flex: 1; padding: 5px 8px; font-size: 13px; font-family: inherit; }
    .input-row textarea.prompt-field { flex: 1; padding: 5px 8px; font-size: 12px; font-family: inherit; height: 32px; resize: vertical; }
    .input-row button.remove-btn { padding: 4px 8px; font-size: 12px; }
    .input-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; font-weight: 600; font-size: 13px; }
    .input-header .hdr-num { min-width: 24px; text-align: right; }
    .input-header .hdr-url { flex: 1; }
    .input-header .hdr-prompt { flex: 1; }
    .input-header .hdr-remove { min-width: 58px; }
  </style>
</head>
<body>
  <h2>Ralph Loop Runner</h2>

  <div class="muted">
    Add URL + optional custom prompt pairs below. Empty prompt fields use the base prompt template.
  </div>

  <div class="row">
    <button id="run">Run</button>
    <button id="stop">Stop</button>
    <label style="margin-left:12px;font-size:13px;">Attempts for all:
      <input type="number" id="globalAttempts" min="1" max="20" value="3" style="width:48px;text-align:center;" />
    </label>
    <button id="applyAttempts">Apply</button>
    <span style="margin-left:12px;"><button id="addRow">+ Add Row</button></span>
    <span class="muted" id="summary"></span>
  </div>

  <div class="input-header">
    <span class="hdr-num">#</span>
    <span class="hdr-url">URL (required)</span>
    <span class="hdr-prompt">Custom Prompt (optional)</span>
    <span class="hdr-remove"></span>
  </div>
  <div id="inputRows"></div>

  <div class="row muted" id="validation"></div>

  <details style="margin: 10px 0;">
    <summary style="cursor:pointer;font-size:13px;font-weight:600;">File Watcher Globs</summary>
    <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
      <label style="font-size:12px;">Progress files:
        <input id="globProgress" type="text" class="mono" style="width:100%;padding:4px 6px;box-sizing:border-box;" />
      </label>
      <label style="font-size:12px;">Spec files:
        <input id="globSpec" type="text" class="mono" style="width:100%;padding:4px 6px;box-sizing:border-box;" />
      </label>
      <label style="font-size:12px;">Requirements files:
        <input id="globReq" type="text" class="mono" style="width:100%;padding:4px 6px;box-sizing:border-box;" />
      </label>
      <button id="applyGlobs" style="align-self:flex-start;">Apply Globs</button>
    </div>
  </details>

  <table>
    <thead>
      <tr>
        <th>Idx</th>
        <th>URL</th>
        <th>Status</th>
        <th>Attempts</th>
        <th>FeatureName</th>
        <th>Signals</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>

<script>
  const vscode = acquireVsCodeApi();

  const DEFAULT_ROWS = 3;
  let rowCount = 0;

  const elRun = document.getElementById('run');
  const elStop = document.getElementById('stop');
  const elTbody = document.getElementById('tbody');
  const elValidation = document.getElementById('validation');
  const elSummary = document.getElementById('summary');
  const elGlobalAttempts = document.getElementById('globalAttempts');
  const elApplyAttempts = document.getElementById('applyAttempts');
  const elAddRow = document.getElementById('addRow');
  const elInputRows = document.getElementById('inputRows');
  const elGlobProgress = document.getElementById('globProgress');
  const elGlobSpec = document.getElementById('globSpec');
  const elGlobReq = document.getElementById('globReq');
  const elApplyGlobs = document.getElementById('applyGlobs');

  // Track user edits so state sync doesn't overwrite in-progress typing
  [elGlobProgress, elGlobSpec, elGlobReq].forEach(function(el) {
    el.addEventListener('input', function() { el.dataset.touched = '1'; });
  });

  function addRow(url, prompt) {
    rowCount++;
    const idx = rowCount;
    const div = document.createElement('div');
    div.className = 'input-row';
    div.dataset.rowId = String(idx);
    div.innerHTML = '<span class="row-num">' + idx + '</span>' +
      '<input class="url-field" type="text" placeholder="https://portal.azure.com/..." value="' + escapeAttr(url || '') + '" />' +
      '<textarea class="prompt-field" placeholder="Leave empty for base prompt\u2026">' + escapeHtml(prompt || '') + '</textarea>' +
      '<button class="remove-btn" title="Remove row">\u2715</button>';
    div.querySelector('.remove-btn').addEventListener('click', () => {
      div.remove();
      renumberRows();
    });
    elInputRows.appendChild(div);
  }

  function renumberRows() {
    const rows = elInputRows.querySelectorAll('.input-row');
    rows.forEach((r, i) => {
      r.querySelector('.row-num').textContent = String(i + 1);
    });
  }

  function getInputPairs() {
    const rows = elInputRows.querySelectorAll('.input-row');
    const pairs = [];
    rows.forEach(r => {
      const url = r.querySelector('.url-field').value.trim();
      const prompt = r.querySelector('.prompt-field').value.trim();
      pairs.push({ url, prompt });
    });
    return pairs;
  }

  function setInputsDisabled(disabled) {
    const rows = elInputRows.querySelectorAll('.input-row');
    rows.forEach(r => {
      r.querySelector('.url-field').disabled = disabled;
      r.querySelector('.prompt-field').disabled = disabled;
      r.querySelector('.remove-btn').disabled = disabled;
    });
    elAddRow.disabled = disabled;
  }

  // Seed default rows
  for (let i = 0; i < DEFAULT_ROWS; i++) addRow('', '');

  elAddRow.addEventListener('click', () => addRow('', ''));

  elRun.addEventListener('click', () => {
    const pairs = getInputPairs();
    // Validate: at least one non-empty URL
    const validPairs = pairs.filter(p => p.url.length > 0);
    if (validPairs.length === 0) {
      elValidation.textContent = 'Please enter at least one URL.';
      return;
    }
    // Warn about invalid URLs
    const invalid = validPairs.filter(p => { try { const u = new URL(p.url); return u.protocol !== 'https:' && u.protocol !== 'http:'; } catch { return true; } });
    if (invalid.length > 0) {
      elValidation.textContent = invalid.length + ' invalid URL(s) will be skipped.';
    } else {
      elValidation.textContent = '';
    }
    vscode.postMessage({ type: 'loadAndRun', pairs: validPairs });
  });

  elStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

  elApplyAttempts.addEventListener('click', () => {
    const val = parseInt(elGlobalAttempts.value, 10);
    if (val >= 1 && val <= 20) {
      vscode.postMessage({ type: 'setAllMaxLoops', value: val });
    }
  });

  elApplyGlobs.addEventListener('click', () => {
    // Reset touched flags after applying
    [elGlobProgress, elGlobSpec, elGlobReq].forEach(function(el) { delete el.dataset.touched; });
    vscode.postMessage({
      type: 'setGlobs',
      progressGlob: elGlobProgress.value.trim(),
      specGlob: elGlobSpec.value.trim(),
      requirementsGlob: elGlobReq.value.trim(),
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'state') {
      render(msg);
      return;
    }
  });

  function render(state) {
    const { running, runId, jobs, queuedCount } = state;

    elSummary.textContent =
      \`RunId: \${runId || '(not running)'} \u2022 Running: \${running ? 'yes' : 'no'} \u2022 Queue: \${queuedCount}\`;

    elRun.disabled = running;
    elStop.disabled = !running;
    elApplyAttempts.disabled = running;
    elGlobalAttempts.disabled = running;
    setInputsDisabled(running);

    // Sync the global attempts input with the config default
    if (!running && state.config) {
      elGlobalAttempts.value = state.config.maxLoopsPerUrl;
    }

    // Sync glob inputs with config
    if (state.config) {
      if (!elGlobProgress.dataset.touched) elGlobProgress.value = state.config.progressGlob || '';
      if (!elGlobSpec.dataset.touched) elGlobSpec.value = state.config.specGlob || '';
      if (!elGlobReq.dataset.touched) elGlobReq.value = state.config.requirementsGlob || '';
    }
    elGlobProgress.disabled = running;
    elGlobSpec.disabled = running;
    elGlobReq.disabled = running;
    elApplyGlobs.disabled = running;

    elTbody.innerHTML = '';
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const signals = [
        j.progressFile ? 'progress' : '',
        j.specFile ? 'spec' : '',
        j.requirementsFile ? 'req' : ''
      ].filter(Boolean).join(', ');

      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td class="mono">\${j.indexLabel}</td>
        <td title="\${escapeHtml(j.url)}" class="mono">\${escapeHtml(j.shortUrl)}</td>
        <td><span class="badge" title="\${escapeHtml(j.failureMessage || '')}">\${escapeHtml(j.status)}\${j.failureMessage ? ' ⚠' : ''}</span></td>
        <td class="mono">
          \${(j.attemptsUsed || 0)}/
          <input type="number" min="1" max="20" value="\${j.maxLoops}" data-set-loops="\${i}" style="width:42px;text-align:center;" \${running ? 'disabled' : ''} />
        </td>
        <td class="mono">\${escapeHtml(j.featureName || '')}</td>
        <td class="mono">\${escapeHtml(signals)}</td>
        <td class="actions">
          <button \${j.progressFile ? '' : 'disabled'} data-open-progress="\${i}">Open progress</button>
          <button \${j.specFile ? '' : 'disabled'} data-open-artifacts="\${i}">Open spec folder</button>
          <button \${(j.status === 'Running' || j.status === 'Planning') ? '' : 'disabled'} data-cancel-job="\${i}" title="Force-fail this job">Cancel</button>
        </td>
      \`;

      tr.querySelectorAll('[data-open-progress]').forEach(btn => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'openProgress', jobIndex: Number(btn.getAttribute('data-open-progress')) }));
      });
      tr.querySelectorAll('[data-open-artifacts]').forEach(btn => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'openArtifacts', jobIndex: Number(btn.getAttribute('data-open-artifacts')) }));
      });
      tr.querySelectorAll('[data-cancel-job]').forEach(btn => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'cancelJob', jobIndex: Number(btn.getAttribute('data-cancel-job')) }));
      });
      tr.querySelectorAll('[data-set-loops]').forEach(inp => {
        inp.addEventListener('change', () => vscode.postMessage({ type: 'setMaxLoops', jobIndex: Number(inp.getAttribute('data-set-loops')), value: Number(inp.value) }));
      });

      elTbody.appendChild(tr);
    }
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'","&#039;");
  }

  function escapeAttr(s) {
    return String(s ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('"','&quot;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;');
  }
</script>
</body>
</html>`;
    }
}
// ---------------------------- helpers ----------------------------
function clampInt(n, min, max) {
    n = Math.floor(Number(n));
    if (Number.isNaN(n))
        return min;
    return Math.max(min, Math.min(max, n));
}
function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}
function makeRunId() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${rand}`;
}
function dedupe(urls) {
    const seen = new Set();
    const out = [];
    for (const u of urls) {
        const key = u.trim();
        if (!key)
            continue;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}
function looksLikeUrl(u) {
    try {
        const url = new URL(u);
        return url.protocol === 'https:' || url.protocol === 'http:';
    }
    catch {
        return false;
    }
}
function shortenUrl(u, max = 70) {
    if (u.length <= max)
        return u;
    return u.slice(0, Math.floor(max * 0.6)) + '…' + u.slice(-Math.floor(max * 0.35));
}
/**
 * Replaces tokens like {{URL}} in the template.
 */
function injectTemplate(template, vars) {
    let out = template;
    for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{{${k}}}`, v);
    }
    return out;
}
/**
 * Strips YAML front matter (--- ... ---) from the beginning of a markdown file.
 */
function stripFrontMatter(text) {
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    if (match) {
        return text.slice(match[0].length);
    }
    return text;
}
function inferFeatureNameFromProgressPath(progressPath) {
    const base = path.basename(progressPath);
    const m = base.match(/^(.*)-progress\.md$/i);
    return m?.[1];
}
function inferFeatureNameFromSpecPath(specPath) {
    const base = path.basename(specPath);
    const m = base.match(/^(.*)\.spec\.ts$/i);
    return m?.[1];
}
function inferFeatureNameFromRequirementsPath(reqPath) {
    const base = path.basename(reqPath);
    const m = base.match(/^(.*)-requirements\.md$/i);
    return m?.[1];
}
/**
 * Parses a .ralph/status/<RunId>/<Item>.status.md file.
 * Expected format (from PlaywrightCoding agent):
 *   RALPH_STATUS: PASS|FAIL
 *   FeatureName: <name>
 *   Timestamp: <iso>
 *   Summary: <text>
 *   SpecPath: <path>        (optional, on PASS)
 *   Reason: <text>          (optional, on FAIL)
 */
function parseStatusFile(text) {
    const lines = text.split(/\r?\n/g);
    const out = {};
    for (const line of lines) {
        const trimmed = line.trim();
        {
            const m = trimmed.match(/^RALPH_STATUS:\s*(PASS|FAIL)\s*$/i);
            if (m)
                out.ralphStatus = m[1].toUpperCase();
        }
        {
            const m = trimmed.match(/^FeatureName:\s*(.+)\s*$/i);
            if (m)
                out.featureName = m[1].trim();
        }
        {
            const m = trimmed.match(/^Timestamp:\s*(.+)\s*$/i);
            if (m)
                out.timestamp = m[1].trim();
        }
        {
            const m = trimmed.match(/^Summary:\s*(.+)\s*$/i);
            if (m)
                out.summary = m[1].trim();
        }
        {
            const m = trimmed.match(/^SpecPath:\s*(.+)\s*$/i);
            if (m)
                out.specPath = m[1].trim();
        }
        {
            const m = trimmed.match(/^Reason:\s*(.+)\s*$/i);
            if (m)
                out.reason = m[1].trim();
        }
    }
    return out;
}
//# sourceMappingURL=extension.js.map