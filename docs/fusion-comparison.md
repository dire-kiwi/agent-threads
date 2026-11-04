# Fusion and Huntaway

A comparison of [Fusion](https://runfusion.ai/) ([Runfusion/Fusion](https://github.com/Runfusion/Fusion), MIT,
`0.78.0-beta.9`, commit `eb7eef49` of 2026-10-26) with Huntaway (`master` at `8935fb5`, API 106), for task AT-35.

**Sources.** The Fusion facts come from its source, cloned and read on 2026-11-04: `README.md`, `CONCEPTS.md`,
`ROADMAP.md`, `STRATEGY.md`, `docs/` and the code under `packages/` and `plugins/`. Paths below are relative to that
repository. The homepage was read too. Fusion wasn't installed or run. "Not found" means it isn't in the code or docs
that were read, not that Fusion definitely lacks it. The Huntaway facts come from its `README.md` and
[the Orca comparison](https://github.com/dire-kiwi/huntaway/blob/master/docs/orca-comparison.md), with what was added
since (API 80–106).

**In one line:** Fusion is a large, fast-moving TypeScript "software factory". Its agents run in-process on the
[Pi](https://pi.dev) coding-agent SDK against any model provider, and it surrounds them with planning, step reviews,
quality gates, missions, agent "companies", a mailbox, analytics and plugins. Huntaway is a smaller Rust server
that drives the real `claude` and `codex` CLIs. Its agents survive server restarts, a human approves tool calls by
default, and it goes deeper on the thread itself: tool calls, subagents, per-turn file checkpoints and rewind, and a
lazygit-style Changes tab. Fusion is far wider: about 30 providers, multi-node over a shared Postgres, native mobile
shells, a file editor, a git manager, missions and plugins. It is more autonomous by default, and less careful about
the agent's process lifetime and about permissions.

## The size of it

| | Fusion | Huntaway |
|---|---|---|
| Code | TypeScript only. About 2.0M lines of `.ts`/`.tsx`, of which about 1.1M are tests (3,693 test files). Packages: dashboard 857k, engine 574k, core 326k, cli 103k, plus 21 plugins | Rust server, React UI, Electron shell |
| Stage | "Early preview", `0.78.0-beta.9`. 232 pending changesets. `docs/` is full of `FN-xxxx` fix references and "legacy and inert" settings. `docs/incidents/2026-05-23-lost-work-tasks.md`: 14 tasks marked Done whose work never reached `main` | Single-user tool in daily use, versioned by API number |
| Built from | A fork of `dustinbyrne/kb`; agents on `@earendil-works/pi-coding-agent` 1.1.0; reviewer modelled on taskplane's | Its own, on the `claude` and `codex` CLIs |

## Side by side

| | Fusion | Huntaway | Ahead |
|---|---|---|---|
| Form factor | Node ≥22 server (Express 5 + React 19 SPA, SSE and WebSockets), `fn`/`fusion` CLI, Ink TUI, Electron desktop app (local or remote mode), Capacitor iOS/Android shells and a PWA, Docker. Install with `npx runfusion.ai`, `curl … \| sh`, Homebrew or npm | Rust server and web UI, Electron shell, installable on a phone as a web app. Linux AppImage, Arch package, Apple silicon `.dmg`, server tarballs, `install.sh`. No Windows or Intel Mac build | Fusion |
| Storage | Embedded PostgreSQL by default (`embedded-postgres`), or an external one via `DATABASE_URL`. SQLite only as legacy migration input. Task files under `.fusion/tasks/{id}` | SQLite per host | — |
| How agents run | **In-process** by default: `packages/engine/src/pi.ts` makes Pi `createAgentSession`s with Pi's coding tools and about 170 `fn_*` board tools. Alternatives: `pi-claude-cli` (a Pi provider that spawns `claude -p` stream-json; Claude proposes tool calls and Pi executes them, "Route A", experimental); a Claude runtime plugin that drives the interactive `claude` in a PTY over an ACP bridge; a "CLI Agent Executor" node that runs Claude Code, Codex, Droid or Pi in a PTY with hooks and tails its JSONL; plugins for Cursor, Droid, Grok, OMP, Antigravity, Hermes, OpenClaw and Paperclip; any ACP agent over stdio (client side only) | The real `claude -p` (stream-json) and `codex app-server`, as child processes under `ia-shim`, with their own tools, permission prompts, subagents, skills and compaction | — |
| Models and providers | About 30 built-in providers (Anthropic, OpenAI and Codex OAuth, Gemini and Vertex, Bedrock, Azure, OpenRouter, Ollama, LM Studio, llama.cpp, Z.ai, Kimi, xAI, Mistral, Groq, Copilot…) plus custom OpenAI-, Anthropic- and Google-compatible endpoints. Model "lanes" (executor, planning, validator, merger, title) with fallbacks, set per task, project or globally | Claude and Codex models through each config's login; `!model` per task; a Claude config can go through an Anthropic-compatible proxy such as CLIProxyAPI (API 106) | Fusion |
| Claude subscriptions | Settings → Authentication runs Anthropic's OAuth paste-code flow. Fusion then calls the API itself with the subscription token. It refreshes it with Claude Code's client id and sends `user-agent: claude-cli/2.1.284`, which `packages/core/src/ai/claude-code-identity.ts` calls "impersonated". Several accounts per provider rotate on usage limits, with a 15-minute cooldown. Alternatively it routes through a logged-in `claude` | Agents run Claude Code itself with the config's own login (`CLAUDE_CONFIG_DIR`); nothing impersonates the CLI | Huntaway (terms-of-service risk) |
| Unit of work | A task with a `PROMPT.md` spec (mission, file scope, steps, acceptance criteria, guardrails, build and test commands), run step by step | A task card: a thread together with its worktree, branch, review and merge | — |
| Columns | Defined by the workflow. The default is Planning (triage), Todo, In progress, In review, Done, Archived; workflows rename, add or drop columns | To do, In progress, Needs attention, In review, Ready for merge, Done; prompts and status scripts per column | — |
| Planning | Triage sizes the task and finds duplicates. A planning agent interviews you, then writes `PROMPT.md`. An AI Plan Review gate is on by default; `requirePlanApproval` (off by default) holds the card for a human. Fast mode skips planning | Plan mode with versioned plan documents, questions in plans, approval that picks the next mode; plans that break into tasks | — |
| Workflows | A visual workflow editor (IR v2: foreach, loop, step-review, code, notify, ask-user, exit-gate…). Built in: coding, quick-fix, review-heavy, stepwise-coding, design, marketing, lead-generation, compound-engineering, a PR fragment | One lifecycle, with prompts per column and status scripts | Fusion |
| Automatic AI review | A read-only reviewer session on the validator lane: per step in some workflows, then a Code Review gate. Verdicts APPROVE / REVISE / RETHINK; RETHINK resets git to the step's start and rewinds the session. Plan reviews block at `high`, code reviews at `critical`. Up to 10 post-review fixes; plan and code revisions unbounded by default | Up to six reviewer agents per project, each with its own instructions and skills (API 105), with fix rounds; summaries before merge, from several summarizers to compare (API 84, 103) | — |
| Quality gates | `testCommand` and `buildCommand` (detected from the lockfile when unset) are hard gates at merge. Optional docs, QA, security, performance, accessibility, UX and browser-verification gates, advisory by default | Reviewers and the project's own scripts; failed PR checks shown on the card | Fusion |
| Worktrees | `.fusion/worktrees/<task-id>` on `fusion/<task-id>`, from the integration or base branch, or per task; rebased before running. `worktreeInitCommand`, `worktreeCopyFiles` (e.g. `.env`), `setupScript`. `maxWorktrees` 4, `maxConcurrent` 2. Optional `worktrunk`. Multi-repo workspaces (`.fusion/workspace.json`). Tasks whose file scopes overlap are serialized | From the freshly fetched base branch, or `from:` a task, branch, PR or commit (API 96); ignored files copied in (`.worktreeinclude` too) and folders linked (API 82); setup and teardown scripts; subprojects; turned off per project or task; Reclaim space | — |
| Merging | `direct` (local squash, the default) or `pull-request`. `autoMerge` on by default, `pushAfterMerge` off. One merge at a time. Conflicts: `smart-prefer-main` (AI resolution, then heuristics, then `-X ours`) in a clean-room `.ai-merge/` worktree. Revert or "AI-undo" a done task | The agent merges in Ready for merge, one task at a time per project, through a PR or not (API 85); dependents then start | — |
| GitHub | Imports issues and PRs; optional tracking issues commented and closed as the task moves; PR badges; a webhook endpoint; `githubNativeAutoMerge` and `requiredChecks`; a review-response loop that sends an agent to fix or reply on PR threads with no human gate before it pushes. Also GitLab import and a Linear plugin | PR link, preview dot and failed checks on the card. Watching PRs in review (API 72): while the agent is idle, failed checks (with their logs' ends) and conflicts, and optionally comments and reviews from people who can push, wake it to fix, push and reply. GitHub accounts per profile and project; clone or create repositories (API 55, 102); webhook automations that turn issues into tasks; Asana links | Fusion |
| Dependencies | A dependency graph (cycles refused) and a Graph view; dependents run in order, the rest in parallel | Dependencies, subprojects and group tasks | — |
| Permissions | `permissionPolicy` presets `unrestricted` (**the default**: every category allowed), `approval-required`, `locked-down`, by category (git write, file write/delete, commands, network…) and per tool. An approval pauses the task and aborts its session until it's decided in the Mailbox's Approvals tab. A CLI agent's own prompts show as a "waiting on input" banner, answered in its terminal | Six modes per host, project and thread, **Ask by default**: the agent's own tool calls wait on approval cards in the thread; project and automation changes always ask | Huntaway |
| Questions | `fn_ask_question` cards in chat; `ask-user` workflow nodes; planning waits for answers | Question cards for `request_user_input`, AskUserQuestion and Codex questions; the card on the board says what's asked | — |
| Steering | Comments injected into the live Pi session with `session.steer()`; `fn task steer`; planner, reviewer and merger see comments on their next pass. A queue of pending messages, kept in the browser, for direct and task chat. Oversight levels off/observe/steer/autonomous (default autonomous) | Steering mid-turn, queued messages kept on the server (taken back to edit), `/compact` and idle compaction | — |
| The thread | Task tabs: Chat, Activity (a chat-styled Live transcript, Feed, Raw logs with tool arguments and results), Summary, Plan, Steps, Changes, Review, Pull request, Stats, Artifacts, Terminal, Session (CLI transcript). `fn_spawn_agent` children (5 per parent, 20 in all); whether they get a nested view wasn't found | One thread with tool calls, diffs, Claude and Codex subagents, permission and question cards, context breakdown | Huntaway |
| Changes and diffs | A Git Manager for the project repository (status, staging, commits, branches, worktrees, stashes, remotes, side-by-side diffs); a Files modal with CodeMirror | Lazygit-style Changes tab per task: stage lines, commit, amend, stash, reset, each turn's diff, line comments to the agent. No editor | — |
| Checkpoints and rewind | Edit and rewind in direct and task chat (the conversation only); Reset and Retry a task; RETHINK resets a step internally. No file checkpoints for you to go back to | A checkpoint of the worktree per turn, and a rewind that puts back the files and the conversation together | Huntaway |
| Surviving restarts | Agents run inside the engine process, by default the same one as the dashboard (per-project child processes are opt-in). On start, `resumeOrphaned()` sends in-progress tasks off again and re-opens the Pi session file. The LLM turn and tool call in flight are lost. CLI agents in PTYs are relaunched with `--resume` (2 tries) | Agents run under `ia-shim` and keep running through server restarts, crashes, rebuilds and updates; the server reads their output on from where it left off. Board tool calls run once, and pending prompts come back | Huntaway |
| Many models, one prompt | Not found | `!model` fan-out, with a Compare view (diffs, cost, review side by side) and *Pick this one* (API 83) | Huntaway |
| Missions and long-running agents | Mission → Milestone → Slice → Feature → Task with autopilot and validation contracts; Goals (5 active); permanent "heartbeat" agents that wake on an interval or a message, claim backlog tasks and reflect; agent "companies" importable in Paperclip's `AGENTS.md` format | Group tasks, subprojects, plans that break into tasks, board MCP tools across profiles and hosts | Fusion |
| Agents talking to agents | A mailbox (inbox, outbox, agents, approvals); experimental multi-agent chat rooms | `send_to_task`, `wait` and task MCP tools | Fusion |
| Memory and research | `.fusion/memory/` with daily notes, per-agent memory and insights, `qmd` search by default; agents update `AGENTS.md` after tasks; research runs (web, GitHub, docs), behind a flag | Claude Code's own memory and skills per config | Fusion |
| MCP and skills | External MCP servers (stdio, SSE, streamable HTTP), global or per project, discovered from Claude Desktop, Claude Code, Cursor, Windsurf and VS Code configs, forwarded to each lane. Board tools are Pi tools; to Claude and Cursor they go through a session-scoped schema-only MCP bridge. No board MCP server for outside clients found. Skills from skills.sh, `/skill:name`, plugin skills | Board tools as an MCP server for every agent; MCP servers and skills per profile and project; skill sources from git (API 104) | — |
| Plugins | A plugin SDK: hooks, tools, routes, UI slots and views, agent runtimes, skills, workflow steps, column traits, MCP servers. 21 first-party plugins (runtimes, agent-browser, roadmap, todos, Linear import, WhatsApp chat, Even Realities glasses…) | None | Fusion |
| Scheduled and triggered work | Automations (shell or multi-step, on a schedule) and routines (AI tasks on cron, signed webhooks or manually) | Interval, time of day, or signed GitHub webhooks with filters, de-duplication and coalescing | — |
| Budgets and limits | `taskTokenBudget` (soft alert, hard pause), agent budgets, compaction at `tokenCap`; no dollar budgets found. Credential rotation on usage limits | Claude and Codex plan limits; a task that hits one waits and carries on when it resets (API 81); restarting the 5-hour window (API 91) | — |
| Usage and analytics | Tokens and USD per task and model; Command Center with Tokens, Tools, Activity, Productivity, Team, Ecosystem, GitHub, Signals, System and Reliability tabs; CSV and OpenTelemetry export | Cost per run and task (Claude), a Tokens tab by purpose, model and task (API 98), time report, calendar, disk | Fusion |
| Several machines | A mesh: nodes find each other over mDNS (`_fusion._tcp`) and HTTP gossip with node API keys, and share state through **one external Postgres**. A task is claimed with a lease and can be routed to a node (`fn task set-node`); worktrees, sessions and logins stay on their node; no failover or live migration | Each host keeps its own data, and boards connect (added, dialling out, or over SSH, through a broker); hosts update to a commit; board tools span hosts | — |
| Accounts and users | One bearer token (or `--no-auth`); several credential accounts per provider. No users or roles (on the ROADMAP) | Profiles (work / personal) with their own logins, projects, GitHub accounts and boards; Copy login between hosts | Huntaway |
| Remote access | Tailscale Serve, Cloudflare named or quick tunnels, QR remote login; "Cloud Link" pairs with Fusion's cloud and runs a quick tunnel | A broker with managed tunnels, or a relay; SSH hosts | — |
| Phone | Capacitor iOS/Android shells (no native projects committed) and a PWA; push and ntfy | A narrow layout, installable as a web app, with web push | Fusion |
| Notifications | ntfy, and Slack, Discord or generic webhooks for many events (in review, merged, failed, awaiting approval, budget…) | Browser notifications or a chime per event, tab and dock badges, phone push | Fusion |
| Terminal, editor, browser | xterm.js terminals with server-side PTYs that outlive the browser, a terminal per task; the CodeMirror Files modal; an agent-browser plugin, a browser verification gate, a dev-server preview, macOS computer use | A tmux shell per task that survives restarts; terminal tool buttons; a preview URL dot | Fusion |
| Telemetry | No analytics SDK found. It checks npm for updates. `@earendil-works/pi-telemetry` is a dependency of the CLI with no direct import found, so whether it sends anything wasn't settled | None | Huntaway (probably) |
| Other | Themes (70+), seven README languages and i18n, voice input, evals and ideation views (flags), a knowledge graph | — | Fusion |

## What Huntaway could take from Fusion

Ranked by value for effort. Huntaway already has two of the things Fusion does here: copying ignored files into new
worktrees (API 82) and waking an agent in review with its PR's failed checks, conflicts and comments (API 72).

1. **Hard test and build gates before merge**: a project's `test` and `build` commands (or ones guessed from the
   lockfile), run in the worktree before Ready for merge; a failure goes back to the agent like a review issue.
2. **Serialize tasks that touch the same files**: hold a task whose plan's file scope overlaps another one in
   progress, to save merge conflicts.
3. **Notification webhooks** (ntfy, Slack, Discord) for needs attention, in review, merged and failed, beside web push.
4. **Token budgets per task**: an alert at a soft limit and a pause into Needs attention at a hard one.
5. **Tracking issues**: optionally make or update a GitHub issue for a task, comment as it moves, and close it at Done
   (or close the issue it was made from).
6. **Import MCP servers from other tools' configs** (Claude Desktop, Cursor, VS Code) into a profile or project.

Not worth taking: running agents in-process on another SDK (Huntaway's strengths come from the real CLIs and
`ia-shim`), calling Anthropic with a subscription token while posing as Claude Code, `unrestricted` permissions by
default, and Fusion's spread of experimental surfaces (missions, companies, chat rooms, glasses).

## What it means for agent-threads

Fusion shows the other way to build this kind of app: own the agent loop (Pi in-process) and treat the CLIs as
optional providers. That buys every model provider and fine control (steering, step rewinds, tools as plain
functions). It costs the CLIs' own behaviour, logins, permission prompts and subagents, and running agents stop when
the process does. Its `pi-claude-cli` provider is the nearest thing to agent-threads' Claude backend, but it runs
`claude -p` only as a model: Claude proposes tool calls and Pi executes them. agent-threads keeps Claude Code and
Codex as the agents, with their tools, permissions, subagents and compaction, and `agent-threads-shim` keeps their
runs alive across restarts. That is the part Fusion doesn't have.

## Sources

- [runfusion.ai](https://runfusion.ai/), [Runfusion/Fusion](https://github.com/Runfusion/Fusion) at `eb7eef49`
- In the repository: `README.md`, `CONCEPTS.md`, `ROADMAP.md`, `STRATEGY.md`, `CHANGELOG.md`; `docs/architecture.md`,
  `docs/task-management.md`, `docs/settings-reference.md`, `docs/workflow-steps.md`, `docs/agents.md`, `docs/mcp.md`,
  `docs/acp-contract.md`, `docs/shared-mesh-protocol.md`, `docs/multi-project.md`, `docs/remote-access.md`,
  `docs/dashboard-guide.md`, `docs/cli-reference.md`, `docs/missions.md`, `docs/PLUGIN_AUTHORING.md`,
  `docs/incidents/2026-05-23-lost-work-tasks.md`
- Code: `packages/engine/src/pi.ts`, `packages/engine/src/executor/run-implementation.ts`,
  `packages/engine/src/executor/resume-orphaned.ts`, `packages/engine/src/executor/wire-executor-lifecycle.ts`,
  `packages/engine/src/execution/reviewer.ts`, `packages/engine/src/cli-agent/`,
  `packages/engine/src/auth/auth-storage.ts`, `packages/core/src/ai/claude-code-identity.ts`,
  `packages/pi-claude-cli/`, `plugins/fusion-plugin-claude-runtime/`
