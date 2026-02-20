# Agent Loop Runner

A VS Code extension that orchestrates AI agent runs over a list of URLs — each URL gets a fresh chat session, a generated prompt, and automated status tracking. Designed for batch-running Copilot custom agents (e.g., Playwright test generation) across multiple pages unattended.

![Agent Loop Runner UI](docs/screenshot.png)

## Features

- **Batch URL processing** — queue up multiple URLs, each gets its own chat session and prompt
- **Per-job custom prompts** — override the base prompt template for individual URLs
- **Automatic retry** — configurable max attempts per URL with retry context carried forward
- **Live status tracking** — file system watchers detect agent-created progress files, spec files, requirements docs, and status markers in real time
- **Configurable file watchers** — glob patterns for all watched file types are editable in the UI and settings
- **Per-job timeout** — optional safety net for unattended runs
- **Cancel/stop controls** — cancel individual jobs or stop the entire queue

## How It Works

1. You provide a list of URLs (and optional per-URL custom prompts) in the webview panel
2. For each URL, the extension:
   - Generates a prompt file at `.agent-loop/prompts/<runId>/<index>.prompt.md` using your template with injected variables (`{{URL}}`, `{{RunId}}`, `{{Item}}`, `{{Attempt}}`, `{{MaxLoopsPerUrl}}`)
   - Opens a new VS Code chat session with the configured agent (via `mode` parameter)
   - Auto-submits the prompt
3. The extension watches for a `.agent-loop/status/<runId>/<index>.status.md` file written by the agent containing `AGENT_STATUS: PASS` or `AGENT_STATUS: FAIL`
4. On PASS → marks the job done and moves to the next URL
5. On FAIL → retries up to the configured max attempts, appending previous-attempt context to help the agent recover

## Quick Start

1. Open this folder in VS Code and press **F5** to launch the Extension Development Host
2. Run the command: **Agent Loop Runner: Open**
3. Enter URLs, adjust settings, and click **Run**

### Install from VSIX

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension agent-loop-runner-0.0.1.vsix
```

## Settings

All settings are under `agentLoopRunner.*` and can also be set in workspace `.vscode/settings.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `maxLoopsPerUrl` | `3` | Max retry attempts per URL (1–20) |
| `featureMapWindowMs` | `120000` | Window (ms) to map newly created progress files to the most recent unmapped running job |
| `promptTemplatePath` | `.github/prompts/basePrompt.md` | Workspace-relative path to the prompt template |
| `agentName` | `PlaywrightPlanning` | Name of the chat agent to route prompts to (must match a `.github/agents/<name>.agent.md` file) |
| `perJobTimeoutMs` | `0` | Max ms to wait for a job's status file. 0 = no timeout. Recommended: `1800000` (30 min) |
| `progressGlob` | `**/src/IntegrationTests/.../*-progress.md` | Glob pattern for agent progress files |
| `specGlob` | `**/.../*/*.spec.ts` | Glob pattern for generated spec files |
| `requirementsGlob` | `**/.../.../*-requirements.md` | Glob pattern for generated requirements files |

The glob settings can also be changed directly in the **File Watcher Globs** section of the UI panel.

## Prompt Template

The extension reads a prompt template file and injects these tokens:

| Token | Replaced with |
|-------|--------------|
| `{{URL}}` | The target URL for the job |
| `{{RunId}}` | Unique run identifier (timestamp + random) |
| `{{Item}}` | Job index label (e.g., `001`, `002`) |
| `{{Attempt}}` | Current attempt number |
| `{{MaxLoopsPerUrl}}` | Max retry attempts for this job |

YAML front matter is stripped from the template and replaced with `mode: agent` front matter for the chat submission.

## Status File Protocol

The agent must write a status file to `.agent-loop/status/<RunId>/<Item>.status.md` with at least:

```
AGENT_STATUS: PASS
FeatureName: <name>
Timestamp: <iso>
Summary: <text>
SpecPath: <path>
```

Or on failure:

```
AGENT_STATUS: FAIL
FeatureName: <name>
Timestamp: <iso>
Summary: <text>
Reason: <cause>
```

## Requirements

- VS Code 1.95+
- GitHub Copilot Chat extension
- A custom agent defined in `.github/agents/` matching the configured `agentName`
