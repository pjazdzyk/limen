# Setup

[README](../README.md) · [Command reference](commands.md)

Install Limen, define the project, and ask an agent to do the work.

## Requirements

- **Operating system:** macOS or Linux. Limen does not support Windows.
- **Tools:** Node.js 24 or later, and Git.
- **Engine:** the selected engine (`omp`, `pi` or `claude`) on `PATH`.
- **Last known-good versions:** omp 18.4.4 and Herdr 0.9.1. Limen records the versions on each job, but it does not refuse other versions.

## Install

### 1. Install Limen

You do this part, one time:

```bash
git clone https://github.com/overment/limen.git
cd limen
npm install
npm link
```

For interactive OMP jobs in Herdr, install the integration:

```bash
herdr integration install omp
```

`npm link` puts that clone on `PATH`. The binary reads `hook/` and `templates/` from the directory next to it. Projects do not copy those files, so when you update the clone, every project on that computer gets the update. After `git pull` on the clone, `/reload` the coordinator.

### 2. Start each project

Open a terminal in the project's Git repository. Before you start a worker, the repository must have at least one commit.

```bash
cd /path/to/your-project
limen init
```

Before you assign work, define these two files:

- `spec/vision.md`: what the product should do, for whom, and within what scope.
- `.agents/limen/styleguide.md`: how to write and organize the code.

Start Pi in that directory with `pi`, or open an agent tab in Herdr with the project as its working directory. Describe the task to the agent in plain language, for example:

> Add a settings page. Follow the project vision and coding styleguide.

You can also ask the agent to help define the vision and styleguide before it changes code. Set the worker and reviewer model choices with the agent in `spec/build.md` (see [Models](#models)).

### What `limen init` does

- **Project files:** It creates the files that the project owns: the vision, the board, the feature lanes, and the styleguide (see [Project files](#project-files)). It does not overwrite existing project files.
- **Hook stubs:** It creates package-hook stubs in `.pi/extensions/` and `.omp/extensions/`. A Herdr OMP coordinator needs the `.omp` stub for communication, wake, and steering, so in an existing project, run `limen init` again before you start one.
- **Old hook copies:** It deletes old `limen-*.ts` hook copies in both extension directories, so that they cannot load next to the stubs.
- **Leftover prompts:** `limen init --drop-leftovers` deletes only prompt copies that are still the same as the package.

### The coordinator session

The agent you talk to is the coordinator. Give it the task in plain language. It manages Limen jobs and reports the results in that session.

**Roles**

- Ordinary `limen spawn` starts workers and reviewers. It does not start a coordinator.
- Team groups have separate lead and hook requirements. Follow the [group setup](groups.md#prepare-and-start) before you use `limen group start`.

**Herdr layout**

- Use a Herdr space with the name of the plant (`limen`, or `alice limen`). Do not use a space with the name `workers` only.
- The coordinator gives its own tab the name of one stable subject (`chat settings`). Limen adds ` · N running` to that name while its jobs run.
- Worker tabs get their names from spawn labels (see [Job IDs and labels](jobs.md#job-ids-and-labels)).
- The inherited shop manual (`templates/agents.md`) has the same layout rules. A project `AGENTS.md` replaces it.

### Project skills

Put project skills in `.agents/skills/<name>/SKILL.md`. Each engine finds skills in these places:

| Location | Found by |
|---|---|
| `.agents/skills/<name>/SKILL.md` | All engines |
| `.omp/skills/<name>/SKILL.md` | OMP |
| `.pi/skills/<name>/SKILL.md` | Pi |
| `.pi/skills/<name>.md` (older flat files) | Pi |

**Old Pi skills in OMP jobs.** For OMP jobs, Limen makes a per-job view of old Pi skills outside the worktree. Limen gives that view to OMP as a skill directory. When two skills have the same name, the skill in `.agents/skills` or `.omp/skills` wins over the old copy. This applies to workers, reviewers, and continuations in both launch modes. It also applies to jobs in a repository next to a non-Git coordinator workspace.

The next launch finds new or changed old skills, so the plant needs no links that you keep by hand. Pi finds skills the same way as before.

## Models

Use this reference when you need to set model choices or run commands yourself.

Project choices are in `spec/build.md`. The board records the engine, provider, model, and reasoning level for each role, and who reviews. The coordinator reads those choices and passes them to the CLI as command flags. The CLI selects settings from flags, environment variables, and package defaults. A newer explicit instruction from the owner has priority over the board. Replace the placeholders in the commands with the project choices.

### Package fallbacks

The coordinator must pass the board choices explicitly. Package fallbacks apply when command flags and environment variables do not select a setting.

**Engine.** `--engine pi|omp|claude` selects the job binary. The order of priority is:

1. `--engine pi|omp|claude`
2. `LIMEN_ENGINE` (for example, `LIMEN_ENGINE=pi` selects Pi)
3. OMP, for new jobs, when neither is set

Two exceptions apply:

- Old job records without an engine stay on Pi, for compatibility.
- A continuation keeps the engine of its parent. `limen continue` refuses a different `--engine`, so to continue a Pi transcript, you still need Pi.

**Model.** The order of priority is:

1. `--model`
2. `LIMEN_WORKER_MODEL` (or `LIMEN_REVIEWER_MODEL` for `--review`)
3. the built-in `openai-codex/gpt-6-astra:high`

**`pi-claude` on OMP.** On OMP, `--model pi-claude/<model>` (without `--provider`) loads the local bridge at `~/.omp/local/pi-claude-bridge` explicitly. This is necessary because jobs otherwise start with `--no-extensions`. `--provider pi-claude` is not an OMP provider.

**Auth.** Pi and OMP keep separate auth stores (`~/.pi` and `~/.omp`). Authenticate each engine you use. Limen does not change the settings or credentials of either engine. One wrapper and one stream parser serve every engine.

### The `claude` engine

`--engine claude` runs the official, unmodified Claude Code binary (`claude -p`) as a detached job in the job's worktree. Log in once with `claude` yourself; the binary authenticates itself. Limen never reads, copies, stores or passes a Claude credential, sets no `ANTHROPIC_*` variable, and its preflight runs only `claude --version`. `LIMEN_CLAUDE` names another binary path.

```bash
limen spawn --engine claude --model sonnet --detached "instruction"
```

- **Model.** `--model` takes a Claude Code alias or model name (`haiku`, `sonnet`, `opus`). Without it, a claude job reads `LIMEN_CLAUDE_MODEL`, then uses `sonnet`; `LIMEN_WORKER_MODEL` and `LIMEN_REVIEWER_MODEL` name OMP models and do not apply.
- **Reasoning.** `--thinking` takes `low`, `medium`, `high`, `xhigh` or `max` and reaches claude as `--effort`.
- **Refused.** `--provider` (other than `anthropic`, which keeps `limen keeper` routes valid), `--extension`, `--tab` and `limen group start --engine claude`. Claude cannot load Limen's hooks, and a hosted tab and a group need them.
- **Permissions.** Nobody answers a prompt in a detached job, so Limen passes `--permission-prompts none`: whatever would ask is denied. By default it also passes `--permission-mode acceptEdits`, which approves file edits inside the worktree only, and `--allowedTools=Bash`, so the worker can run checks and commit. No bypass is on by default. `LIMEN_CLAUDE_PERMISSION_MODE` (`acceptEdits`, `auto`, `dontAsk`, `plan` or `bypassPermissions`) and `LIMEN_CLAUDE_ALLOWED_TOOLS` (comma-separated, for example `Bash(npm *),Bash(git *)`; empty for none) override them. `bypassPermissions` is the blanket bypass: set it only for a worktree on a machine you would let any command run on. Pre-approved `Bash` can still write outside the worktree; narrow it with `LIMEN_CLAUDE_ALLOWED_TOOLS` when that matters. The job log records the mode and tools it ran with.
- **Your Claude settings apply.** A job runs with your own Claude Code settings, hooks and plugins, as `claude` would in that folder. `LIMEN_CLAUDE_SETTINGS` (a settings file path or JSON) adds settings for jobs only, through `--settings`. Claude Code adds a `Co-Authored-By` trailer to the commits it makes, so when `LIMEN_CLAUDE_SETTINGS` is unset Limen passes `{"attribution":{"commit":"","pr":""}}`, which turns that off. Set the variable to an empty string to get Claude Code's own behaviour.
- **Same as OMP.** The job record, `limen wait`, `jobs`, `stop`, timeout, tool-call cap, stalled-tool detection, review mode, `land` and the Herdr log tab. `limen steer` writes the steer inbox as for any job; the wrapper sends each steer to claude as a stream-json user message, which claude takes between tool calls. `limen continue` resumes the parent's Claude Code session (`--resume`) in the same worktree. The stream is copied into `session/<session-id>.jsonl`.
- **Different from OMP.** Claude runs detached only: in Herdr a spawn without `--detached` falls back to detached with a note, and there is no hosted tab. The communication hook's guidance (register, styleguide, ticket, vision and board pointers) goes in once, with the system prompt and the first message, instead of every turn; its reminders after tool results are not given. Old `.pi/skills` are not offered; Claude Code reads its own skills and the worktree's `CLAUDE.md`.

### Personal model routes and Pi extensions

An owner can describe an approved model route in their active personal coordinator instructions or a session handoff: the request name, exact engine/provider/model/thinking choices, and trusted local extension paths. Keep personal paths outside shared project Git. Limen does not parse aliases, scan installed packages, or choose a route from installation alone. Resolve conflicts with project policy before launching; do not silently substitute an engine, provider or model.

For a Pi worker, pass each selected path explicitly:

```text
limen spawn --engine pi --provider <provider> --model <model> --thinking <level> \
  --extension /path/to/trusted-entry.ts --label "what this changes" "instruction"
```

`--extension` accepts local files and package directories in both hosted and detached modes. Limen does not install or import them; Pi loads them. A directory can expose several extensions and other package resources, so prefer the exact entry file when that is the intended selection. Ambient extensions stay disabled. See [command details](commands.md#start-and-continue-jobs) for path rules and continuation replacement.

Extensions run with the worker process's permissions and can read files, credentials and session data. Path validation does not prove API compatibility, provider availability, instruction forwarding or successful inference. Keep installation, native model-catalog registration and a successful worker check as separate claims. The optional `LIMEN_PREFLIGHT=auth` check does not load session extensions and can reject an extension-only provider; Limen does not bypass it. For native Pi groups, the owner selects common or team-only extensions at `group start`; members inherit the fixed team lists. See [group selection](groups.md#prepare-and-start). Ordinary selections do not automatically propagate to GitHub launches, picture jobs or native subagents.

### Start a coordinator in a Herdr pane

To start a coordinator in an existing Herdr pane, use a shell prompt with the project as the working directory:

```bash
herdr agent start limen-peer --kind <engine> --pane <pane-id> -- \
  --provider <provider> --model <model> --thinking <level>
```

Herdr sends on the arguments after `--`, but Herdr does not select the model for Limen. Do not depend on old Pi project settings or a global default model.

### Start a worker

For an ordinary worker:

```bash
limen spawn --engine <engine> \
  --provider <provider> --model <model> --thinking <level> \
  --label "what this changes · FNNN" 'Implement FNNN: <outcome>. Ticket: spec/features/active/FNNN-slug/ticket.md'
```

In Herdr, this job is hosted. Use `--detached` when someone asks for a background worker. In both modes, `--provider`, `--model`, and `--thinking` go to the selected engine as separate flag and value pairs. `limen continue` accepts the same flags.

## Adjacent-repository workspaces

A parent directory that is not a Git repository can hold several independent Git repositories as children.

1. Run `limen workspace init` one time in the parent.
2. List the children in `spec/workspace.md`.
3. Tell the coordinator which repository the work is for.

The coordinator gives exactly one `--repo` to each job. Tickets stay in the parent. Branches, worktrees, diffs, and review stay in the selected child.

## Project files

The installed `limen` package supplies the default shop manual, role prompts, speech register, and hooks. `limen init` creates only the files that the project owns:

```text
.agents/limen/styleguide.md           project coding practice
spec/vision.md                        durable product intent
spec/build.md                         TRACK / NOW / NEXT / PROVEN
spec/features/                        planned, active, done, and dropped work
.pi/extensions/limen.ts               Pi stub: load hooks from the package
.omp/extensions/limen.ts              OMP stub: load the same hooks
.limen/jobs/<id>/                     runtime evidence
```

### Overlays

Optional overlays replace a package default, one file at a time:

- `AGENTS.md`
- `.agents/limen/worker.md`
- `.agents/limen/reviewer.md`
- `.agents/limen/communication.md`

| File | Name | What happens |
|---|---|---|
| Same bytes as the package | Old copy | The coordinator names it. |
| Different bytes | Overlay | You can keep it, drop it, or edit it. **Never overwrite an overlay.** |

### Hooks

The communication hook puts the shop manual, the speech register, the vision, and the styleguide in the system prompt for each model call. The board digest comes last, so a change to NOW or NEXT does not break the cached prefix.

A short note on each turn names the audience and the reply rules. The wake cue is in that note, not in the system prompt. After a write or an edit, the tool result repeats the rule that applies.
