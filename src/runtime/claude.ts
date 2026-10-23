// The `claude` engine: the official, unmodified Claude Code binary in print mode (`claude -p`).
// Limen never reads, copies, stores or passes a Claude credential; the binary authenticates itself with the
// owner's own login. Limen only chooses argv, the working directory (the job's worktree) and what goes on stdin.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, type FSWatcher, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Writable } from "node:stream";
import { jobGuidance } from "../../hook/communication.ts";
import { sweepSteers } from "../../hook/steering.ts";
import { noteCheck, noteStart, recordNote } from "../job/task-note.ts";
import { readOptional } from "../project/inherit.ts";
import type { EngineArgv } from "./engine.ts";

const EFFORT = ["low", "medium", "high", "xhigh", "max"];
// `bypassPermissions` is the blanket bypass: opt-in only, through LIMEN_CLAUDE_PERMISSION_MODE.
const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/**
 * Nobody answers a permission prompt in a detached job, so `--permission-prompts none` denies whatever would ask.
 * By default `acceptEdits` approves file edits inside the worktree (the working directory) only, and `Bash` is
 * pre-approved so the worker can run checks and commit. LIMEN_CLAUDE_PERMISSION_MODE and LIMEN_CLAUDE_ALLOWED_TOOLS
 * (comma-separated, empty for none) override both.
 */
export function claudePermissions(): { readonly mode: string; readonly tools: readonly string[] } {
	const mode = process.env.LIMEN_CLAUDE_PERMISSION_MODE?.trim() || "acceptEdits";
	if (!PERMISSION_MODES.includes(mode)) {
		throw new Error(`LIMEN_CLAUDE_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(", ")}`);
	}
	const tools = (process.env.LIMEN_CLAUDE_ALLOWED_TOOLS ?? "Bash")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return { mode, tools };
}

/** Flags a claude job cannot honour are refused before any job record exists. */
export function checkClaudeFlags(input: {
	readonly model?: string | undefined;
	readonly provider?: string | undefined;
	readonly thinking?: string | undefined;
	readonly extensions: readonly string[];
}): void {
	if (input.provider && input.provider !== "anthropic") {
		throw new Error("--provider is for pi and omp; claude uses its own login (omit --provider, or pass anthropic)");
	}
	if (input.extensions.length) {
		throw new Error("--extension is for pi and omp; claude cannot load Limen or worker extensions");
	}
	if (input.thinking && !EFFORT.includes(input.thinking)) {
		throw new Error(`claude takes --thinking ${EFFORT.join(", ")} (passed to claude as --effort)`);
	}
	if (input.model?.includes("/")) {
		throw new Error("claude takes a Claude Code model alias or name (haiku, sonnet, opus), not provider/model");
	}
	claudePermissions();
}

/** Runs only `claude --version`: the binary must start. Its login is its own business and is never probed. */
export function preflightClaude(binary: string): void {
	const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
	if (result.error || result.status !== 0) {
		throw new Error(
			`${binary} --version failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`,
		);
	}
}

export function claudeArgv(slots: EngineArgv): string[] {
	if (!slots.jsonMode) {
		throw new Error("claude jobs run detached only; a Herdr-hosted claude tab is not supported");
	}
	if (!slots.session) {
		throw new Error("claude job has no session id");
	}
	const { mode, tools } = claudePermissions();
	const args = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
	args.push(slots.continueValue === undefined ? "--session-id" : "--resume", slots.session);
	args.push("--permission-prompts", "none", "--permission-mode", mode);
	if (tools.length) {
		args.push(`--allowedTools=${tools.join(",")}`);
	}
	// The job folder sits outside the worktree: without it the worker cannot write its task note.
	args.push("--add-dir", slots.jobDir);
	args.push("--append-system-prompt", slots.preamble);
	if (slots.model) {
		args.push("--model", slots.model);
	}
	if (slots.thinking) {
		args.push("--effort", slots.thinking);
	}
	// Settings for jobs only (a file path or JSON). The default switches off the commit and PR attribution lines,
	// the house style; an explicit empty LIMEN_CLAUDE_SETTINGS leaves Claude Code's own behaviour alone.
	const configured = process.env.LIMEN_CLAUDE_SETTINGS;
	const settings = configured === undefined ? '{"attribution":{"commit":"","pr":""}}' : configured.trim();
	if (settings) {
		args.push("--settings", settings);
	}
	return args;
}

/** A continuation resumes the session its copied transcript names; a new job starts a new one. */
async function claudeSession(jobDir: string, resume: boolean): Promise<string> {
	if (!resume) {
		return randomUUID();
	}
	const name = (await readdir(`${jobDir}/session`).catch(() => [] as string[]))
		.filter((entry) => SESSION_FILE.test(entry))
		.sort()
		.at(-1);
	if (!name) {
		throw new Error("claude continuation has no parent session to resume");
	}
	return name.slice(0, -".jsonl".length);
}

/**
 * The session, system prompt and first message of a claude job. The Pi/OMP communication hook adds the project's
 * guidance to every turn; claude cannot load it, so the same text rides the system prompt and the first message once.
 */
export async function claudeLaunch(input: {
	readonly jobDir: string;
	readonly root: string;
	readonly taskFile: string;
	readonly preamble: string;
	readonly resume: boolean;
}): Promise<{ readonly session: string; readonly preamble: string; readonly message: string }> {
	const guidance = jobGuidance(input.root);
	const task = (await readFile(input.taskFile, "utf8")).trim();
	return {
		session: await claudeSession(input.jobDir, input.resume),
		preamble: guidance.system ? `${input.preamble}\n\n${guidance.system}` : input.preamble,
		message: `${guidance.cue}\n\n${noteStart(input.jobDir)}\n\n${task}`,
	};
}

export type ClaudeDriver = {
	/** Copies raw stream output into `session/<id>.jsonl`, the transcript `limen continue` and the picture read. */
	tee(chunk: string): void;
	/** A turn ended. Close stdin, so claude exits, unless a steer was just delivered and starts another turn. */
	settled(): void;
	close(): void;
};

/**
 * The task and every `limen steer` reach claude as stream-json user messages on stdin. Claude takes a message
 * that arrives mid-turn between tool calls, the same place the Pi/OMP steering hook delivers.
 */
export function driveClaude(stdin: Writable, jobDir: string, session: string, task: string): ClaudeDriver {
	const transcript = `${jobDir}/session/${session}.jsonl`;
	mkdirSync(`${jobDir}/session`, { recursive: true });
	mkdirSync(`${jobDir}/steer/inbox`, { recursive: true });
	stdin.on("error", () => {});
	const send = (text: string) => {
		stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
	};
	send(task);
	let open = true;
	let buffer = "";
	// The task note: the hook that does this for Pi and OMP cannot load in claude, so the driver keeps the copy and the log.
	let noteSeen = readOptional(`${jobDir}/note.md`);
	let checked = false;
	const sweep = () => {
		noteSeen = recordNote(jobDir, noteSeen);
		return open ? sweepSteers(jobDir, send) : 0;
	};
	writeFileSync(`${jobDir}/steer/ready`, "1\n");
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(`${jobDir}/steer`, { recursive: true }, () => void sweep());
		watcher.on("error", () => watcher?.close());
	} catch {
		// Polling still delivers.
	}
	const timer = setInterval(sweep, 500);
	const close = () => {
		if (!open) {
			return;
		}
		open = false;
		if (buffer.trim()) {
			appendFileSync(transcript, `${buffer}\n`);
		}
		buffer = "";
		clearInterval(timer);
		watcher?.close();
		rmSync(`${jobDir}/steer/ready`, { force: true });
		stdin.end();
	};
	return {
		tee(chunk) {
			const lines = (buffer + chunk).split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines.filter((entry) => entry.trim())) {
				appendFileSync(transcript, `${modelChange(line)}${line}\n`);
			}
		},
		settled() {
			if (sweep()) {
				return;
			}
			if (!checked && open) {
				// Once, before the end: the same note check the finish hook sends to Pi and OMP jobs.
				checked = true;
				appendFileSync(`${jobDir}/log`, `[limen ${new Date().toISOString()}] note check sent\n`);
				send(noteCheck(jobDir, false));
				return;
			}
			close();
		},
		close,
	};
}

/** The picture reads a job's model from a `model_change` entry; claude names its model in the init event. */
function modelChange(line: string): string {
	if (!line.includes('"init"')) {
		return "";
	}
	try {
		const event = JSON.parse(line) as { type?: unknown; subtype?: unknown; model?: unknown };
		return event.type === "system" && event.subtype === "init" && typeof event.model === "string"
			? `${JSON.stringify({ type: "model_change", model: `anthropic/${event.model}` })}\n`
			: "";
	} catch {
		return "";
	}
}
