# Ralph Loop Runner

A VS Code extension that orchestrates PlaywrightPlanning agent runs over a list of URLs.

## How it works
- Writes prompt files to `.ralph/prompts/<runId>/<index>.prompt.md`
- For each URL:
  - new chat session
  - switch to PlaywrightPlanning agent
  - run prompt file
- Watches repo artifacts:
  - progress file markers: `FinalStatus: PASS|FAIL` (authoritative)
  - spec creation
  - requirements creation

## Settings
- `ralphLoopRunner.maxLoopsPerUrl` – Max retry attempts per URL, 1–20 (default: 3)
- `ralphLoopRunner.featureMapWindowMs` – Window (ms) to map newly created progress files to the most recent unmapped running job (default: 120000)
- `ralphLoopRunner.promptTemplatePath` – Workspace-relative path to the prompt template (default: `.github/prompts/basePrompt.md`)
- `ralphLoopRunner.agentName` – Name of the chat agent to address prompts to (default: `PlaywrightPlanning`)
- `ralphLoopRunner.perJobTimeoutMs` – Max milliseconds to wait for a single job's agent status file. 0 = no timeout (default: 0). Recommended: 1800000 (30 min) as a safety net.

## Run
Open this folder (`ralph-loop-runner/`) in VS Code and press F5 to launch Extension Development Host.
Run command: `Ralph Loop Runner: Open`.
