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
