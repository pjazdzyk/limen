<p align="left">
  <a href="https://mega.dev">
    <img src="docs/assets/mega-logo-badge.svg" alt="MEGA.dev" width="220" height="60">
  </a>
</p>

# Limen

> **[Explore the full workflow → Towards Autonomous Product Development](https://mega.dev/autonomous-product-development)**
>
> This MEGA Drop explains the workflow behind Limen. It includes a live video walkthrough with Pi, Herdr, and Grok Bot. [MEGA.dev](https://mega.dev) shares practical articles, repos, and tools for work with AI.

You describe a task to an agent in Pi or Herdr.
The agent uses Limen to plan work, start workers, and request review.
Jobs run in separate Git worktrees and keep their task, branch, log, state, and session.
You review the results and approve merges.

Experimental software. Commands, prompts, and project files can change.

## Requirements

- macOS or Linux, with Node.js 24 or later and Git.
- [Pi](https://pi.dev), OMP or Claude Code (`claude`), installed and authenticated.
- Herdr is optional for interactive job tabs.
- A Devin account is optional, for jobs that run as Devin cloud sessions (`--engine devin`).

See the [setup guide](docs/setup.md) for engine and Herdr configuration.

## Start

Install Limen once:

```bash
git clone https://github.com/overment/limen.git
cd limen
npm install
npm link
```

In your project’s Git repository, run:

```bash
cd /path/to/your-project
limen init
```

Open Pi (`pi`) in that directory, or start an agent tab in Herdr.
Before you ask for code, define these project files:

- `spec/vision.md`: what the project should do, who it serves, and its scope.
- `.agents/limen/styleguide.md`: code structure, conventions, and required checks.

You can ask the agent to help:

> Help me define the project vision and code styleguide before we start work.

`limen init` preserves existing specs. The repository must have at least one commit before a worker starts.

Planning is committed to Git by default. To keep planning private, run `limen planning private`. Planning files then stay in the canonical project root, and jobs read them through absolute paths. Limen does not copy them into worktrees. `limen planning` shows the current setting. `limen planning committed` restores the default for new jobs.

To update Limen, pull the package clone and use `/reload` in the agent session.
All projects on that computer use the same installed package.

## Work

1. Tell the agent the result you need, such as “Add email sign-in.”
2. The agent records a ticket, starts jobs, and requests review.
3. Inspect the result and approve the merge.

The specs describe the work. `spec/build.md` records its state.
A completed job does not prove that a feature is finished or that its branch is ready to merge.

Workers approve tools automatically and have the same access as your account.
A Git worktree is not a security sandbox. Read the [security notes](SECURITY.md).

## Picture

After `limen init`, ask the agent:

> Create a Picture map from the code and specs, and open it in my browser.

See the [Picture guide](docs/picture.md) for navigation and updates.

## Task-note experiment (started 2026-10-22)

The experiment started on 2026-10-22 at 12:17 CEST (UTC+2), when this change landed on `main`. Jobs that started before that time have no note.

**What changed.** Every Limen job keeps a task note in `.limen/jobs/<id>/note.md`. Team coordinators of a group get one too; the top-level coordinator session does not. The agent writes the note. Limen copies and shows it, and never parses it.

- **The format.** A nested log list in plain technical English: short sentences, one fact on each line. Each line starts with a marker: 🔴 must deliver or must keep, 🟡 useful context, ⚪ minor or assumption. Detail goes under its main point. A change is a new line under the point it changes, such as `🟡 changed: ... Reason: ...`; the old line stays.
- **The files.** Limen keeps the first version of the note as `note.first.md`, and adds a `note changed` line to the job log at each change. `limen continue` copies both files into the new job folder.
- **Three injections.** The first prompt of each job, also a continued one, asks the agent to read or write the note, with the format and one example. Each steer asks the agent to add a changed line when the steer changes a point. Once before the finish, Limen shows the note now, the note at the start and the project reminders. The agent marks each 🔴 point delivered, changed or dropped, with the reason, under the heading "Note check" in its final message. Without a note, the agent lists its 🔴 points from memory.
- **Before the finish.** The first `finish` call gets the check and does not end the job. A detached run that ends without `finish` gets the check as one more turn (Pi 1.2.0 or later, and OMP). A hosted job whose agent never calls `finish` gets no check. The log records `note check sent`. Devin jobs run no Limen hooks and get no note.

**Project reminders.** A project can name points that every job must keep. Write them in `.agents/limen/reminders.md`, in the same format, and commit the file:

```markdown
- 🔴 Every database migration has a down step.
- 🟡 The staging database resets each night.
```

Limen adds the file to the first prompt and to the check before the finish, and the steer line names the reminders. The agent checks each 🔴 reminder as it checks a 🔴 point of its note. When the file is absent, no injection mentions reminders. Limen reads the file in the project root, so an edit applies to the next prompt, steer or check.

**How to measure, after about one week.** Compare the jobs that started before the start time with the jobs that started after it:

1. The share of finishes that report each 🔴 point.
2. The 🔴 points that were changed or dropped, and whether each has a reason.
3. The reviewer FAIL rate.
4. The steers and `limen continue` runs for each job.
5. The share of notes written in the first turns of the job.

Read these files in each `.limen/jobs/<id>/`: `note.md` (the note at the end), `note.first.md` (its first version), `log` (the `note changed`, `note check sent` and `steered:` lines with their times, and the tool lines before the first `note changed`), and `result` (the final message with its "Note check"). `started-at` gives the start of the job, `role` marks a reviewer, and `parent` marks a continued job.

## Documentation

| Topic | Guide |
| --- | --- |
| Setup, models, skills, and project files | [Setup](docs/setup.md) |
| Jobs, reviews, continuation, and recovery | [Jobs](docs/jobs.md) |
| CLI commands and options | [Command reference](docs/commands.md) |
| Code structure, features, and journeys | [Picture](docs/picture.md) |
| Several teams on one feature | [Team groups](docs/groups.md) |
| Remote jobs and GitHub requests | [Remote seats](docs/remote.md) |
| Job and coordinator event webhooks | [Finish webhooks](docs/finish-webhooks.md) |
| Pane status and job status | [Herdr status](docs/herdr-status.md) |
| Optional Linear mirror | [Linear](templates/linear.md) |

See [Contributing](CONTRIBUTING.md) for development and checks.
