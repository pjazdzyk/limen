import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { jobMembership } from "../job/group-cabinet.ts";
import { appendLimenLog, atomicWrite, textFile } from "../job/record.ts";
import { completionWake, keeperHint } from "../job/wake-text.ts";
import { herdrBinary } from "./herdr.ts";

const PROMPT_MS = 15_000;
const ATTEMPTS = 2;
// Up to this size a prompt goes as a `herdr agent prompt` argument, under Linux's 128 KiB limit for one argument.
// A longer prompt goes as one request on Herdr's socket API. Herdr 0.9.5 reads at most 1 MiB in one request line
// (src/api/server.rs), and only while the line arrives within 5 s; no Herdr request can carry more.
const ARGUMENT_BYTES = 96 * 1024;
const REQUEST_BYTES = 1024 * 1024;
// Herdr refuses these before it sends any input; a Herdr the OS did not start, a socket that took no connection, a
// prompt too large for one request and a request Herdr closed before its end sent nothing. Every other failure may
// follow a submission.
const UNSENT =
	/\b(agent_blocked|agent_not_found|target_not_found|pane_not_found|herdr not started|socket unavailable|prompt_too_large|request not taken)\b/;

/**
 * Start a turn on the Herdr pane that spawned this job. Only jobs whose coordinator had no Pi session record
 * `origin-pane`; Pi coordinators keep their in-process wake. A group member never wakes anyone: the group tells its
 * lead once, after its last round (`limen group advance`).
 * Claimed once per job by `notify/herdr-prompt`, which keeps one line per attempt (see `promptPane`), so a coordinator
 * hears its wake once. `notify/delivered/_herdr` is written only when Herdr observed the pane working after submission.
 */
export async function promptCoordinator(jobDir: string, shutdownDeadline = Number.POSITIVE_INFINITY): Promise<void> {
	await promptOriginPane(jobDir, await wakeMessage(jobDir), COMPLETION, shutdownDeadline);
}
/** A job that waited in the start queue tells its pane once that it started: `notify/herdr-start`, never the wake's receipt. */
export async function promptStartNotice(jobDir: string, message: string): Promise<void> {
	// LIMEN_START_NOTICE=off: the coordinator hears a job only when it ends; the finish wake names the wait.
	if (process.env.LIMEN_START_NOTICE === "off") {
		return;
	}
	await promptOriginPane(jobDir, message, START, Number.POSITIVE_INFINITY);
}
type PaneRoute = { readonly receipt: string; readonly delivered: string; readonly name: string };
const COMPLETION: PaneRoute = { receipt: "herdr-prompt", delivered: "_herdr", name: "coordinator wake via Herdr" };
const START: PaneRoute = { receipt: "herdr-start", delivered: "_start._herdr", name: "start notice via Herdr" };
/** Claims the route's receipt once per job, prompts the job's `origin-pane`, and records a delivery Herdr observed. */
async function promptOriginPane(
	jobDir: string,
	message: string | undefined,
	route: PaneRoute,
	deadline: number,
): Promise<void> {
	const pane = await textFile(`${jobDir}/origin-pane`);
	const herdr = herdrBinary();
	if (!message || !pane || !herdr || deadline - Date.now() < 1_000) {
		return;
	}
	await mkdir(`${jobDir}/notify`, { recursive: true });
	const receipt = `${jobDir}/notify/${route.receipt}`;
	try {
		await writeFile(receipt, `attempting ${pane} ${new Date().toISOString()}\n`, { flag: "wx", flush: true });
	} catch {
		return; // Another finalizer already owns this wake.
	}
	const ok = await promptPane(herdr, pane, message, deadline, receipt, (line) =>
		appendLimenLog(jobDir, `${route.name}: ${line}`),
	);
	if (ok) {
		await mkdir(`${jobDir}/notify/delivered`, { recursive: true });
		await writeFile(`${jobDir}/notify/delivered/${route.delivered}`, `${new Date().toISOString()}\n`, {
			flag: "wx",
			flush: true,
		}).catch(() => {});
	}
}

/**
 * Prompt one Herdr pane after the caller claimed `receipt`, and keep one receipt line per attempt; `note` hears each
 * attempt as it ends. Only an attempt Herdr refused before it sent any input is tried again, at most twice; text that
 * may have reached the pane is never sent again. True when Herdr observed the pane working after submission.
 */
export async function promptPane(
	herdr: string,
	pane: string,
	message: string,
	deadline: number,
	receipt: string,
	note: (line: string) => Promise<void> = async () => {},
): Promise<boolean> {
	const lines: string[] = [];
	let ok = false;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const budget = Math.min(PROMPT_MS, deadline - Date.now());
		if (budget < 1_000) {
			lines.push("no time left for another attempt; deliver this text to the pane deliberately");
			break;
		}
		const outcome = await herdrPrompt(herdr, pane, message, budget);
		const result = outcome.ok
			? `turn observed on ${pane}`
			: /agent_prompt_stalled/.test(outcome.detail)
				? `delivered to ${pane}, turn not seen`
				: UNSENT.test(outcome.detail)
					? `not sent to ${pane}: ${outcome.detail}`
					: `may have reached ${pane}, turn not seen (${outcome.detail}); not resent`;
		lines.push(`attempt ${attempt}: ${result} ${new Date().toISOString()}`);
		await note(`attempt ${attempt}: ${result}`);
		if (outcome.ok) {
			ok = true;
			break;
		}
		if (!UNSENT.test(outcome.detail)) {
			break;
		}
		if (attempt < ATTEMPTS) {
			await atomicWrite(receipt, `attempting ${pane}\n${lines.join("\n")}\n`);
		} else {
			lines.push(
				`automatic delivery stopped after ${ATTEMPTS} attempts Herdr did not send; deliver this text to the pane deliberately`,
			);
		}
	}
	await atomicWrite(receipt, `${lines.join("\n")}\n`);
	return ok;
}

async function wakeMessage(jobDir: string): Promise<string | undefined> {
	const [label = "", state = "", branch = "", repo = ""] = await Promise.all(
		["label", "state", "branch", "repo"].map((name) => textFile(`${jobDir}/${name}`)),
	);
	const id = jobDir.split("/").at(-1) ?? "";
	const membership = await jobMembership(jobDir);
	if (!membership) {
		const keeper = state === "done" ? ` ${keeperHint(jobDir, id)}` : "";
		const instruction = `Start with \`limen jobs ${id}\`. Inspect its diff, commits, final message, and checks before landing. If a check blocks landing, name that check and resume a focused fix.${keeper} Keep the user informed; ask only when a genuine product decision needs them.`;
		return completionWake(jobDir, label || id, state, id, branch, repo, { instruction });
	}
	await appendLimenLog(
		jobDir,
		`coordinator wake via Herdr: not sent; group ${membership.run.id} tells its lead once, after its last round`,
	);
	return;
}

type Outcome = { readonly ok: boolean; readonly detail: string };

/**
 * Submit `text` to the agent on `pane` once, and wait until Herdr sees it working or blocked, within `budget` ms. A short
 * text goes as a `herdr agent prompt` argument. A longer one goes whole as the same `agent.prompt` request on the socket
 * `herdr status` names, as the OS limits one argument. `detail` keeps Herdr's own reply line, which names its code.
 */
export async function herdrPrompt(herdr: string, pane: string, text: string, budget: number): Promise<Outcome> {
	const wait = (ms: number) => Math.max(ms - 2_000, 1_000);
	if (Buffer.byteLength(text) <= ARGUMENT_BYTES) {
		const args = ["agent", "prompt", pane, text, "--wait", "--until", "working", "--until", "blocked"];
		return run(herdr, [...args, "--timeout", String(wait(budget))], budget);
	}
	const request = (ms: number) =>
		JSON.stringify({
			id: "limen:agent.prompt",
			method: "agent.prompt",
			params: { target: pane, text, wait: { until: ["working", "blocked"], timeout_ms: wait(ms) } },
		});
	const bytes = Buffer.byteLength(request(budget));
	if (bytes > REQUEST_BYTES) {
		return {
			ok: false,
			detail: `prompt_too_large: ${bytes} bytes; Herdr takes at most ${REQUEST_BYTES} in one request`,
		};
	}
	const started = Date.now();
	const socket = await serverSocket(herdr, Math.min(5_000, budget));
	const left = budget - (Date.now() - started);
	if (!socket || left < 1_000) {
		return {
			ok: false,
			detail: `socket unavailable: ${socket ? "no time left" : "herdr status names no running server"}`,
		};
	}
	return send(socket, request(left), left);
}

/** The socket of the running Herdr server this binary talks to, as `herdr status` resolves it (session, environment). */
function serverSocket(herdr: string, timeout: number): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	execFile(herdr, ["status", "--json"], { encoding: "utf8", timeout }, (error, stdout) => {
		const server = error ? undefined : parsed(stdout)?.server;
		resolve(server?.running && typeof server.socket === "string" ? server.socket : undefined);
	});
	return promise;
}

/** One request line on Herdr's socket, and its one reply line. */
function send(socket: string, request: string, timeout: number): Promise<Outcome> {
	const { promise, resolve } = Promise.withResolvers<Outcome>();
	const conn = connect(socket);
	let connected = false;
	let written = false;
	let reply = "";
	const end = (outcome: Outcome) => {
		clearTimeout(timer);
		conn.destroy();
		resolve(outcome);
	};
	const timer = setTimeout(() => end({ ok: false, detail: `herdr exceeded ${timeout}ms` }), timeout);
	conn.setEncoding("utf8");
	conn.on("connect", () => {
		connected = true;
		// Herdr acts only on a whole line, so a socket closed before the write ended took no request.
		conn.write(`${request}\n`, (error) => {
			written = !error;
		});
	});
	conn.on("data", (chunk: string) => {
		reply += chunk;
		if (reply.includes("\n")) {
			const line = reply.slice(0, reply.indexOf("\n"));
			end({ ok: parsed(line)?.result !== undefined, detail: line });
		}
	});
	conn.on("error", (error: NodeJS.ErrnoException) => {
		if (!connected) {
			end({ ok: false, detail: `socket unavailable: ${error.code ?? error.message}` });
		}
	});
	conn.on("close", () => {
		const detail = written
			? "herdr closed the socket without a reply"
			: "request not taken: Herdr closed the socket before the prompt's end arrived";
		end({ ok: false, detail });
	});
	return promise;
}

type Reply = { readonly result?: unknown; readonly server?: { readonly running?: boolean; readonly socket?: unknown } };
function parsed(line: string): Reply | undefined {
	try {
		return JSON.parse(line);
	} catch {
		return;
	}
}

function run(binary: string, args: readonly string[], timeout: number): Promise<Outcome> {
	const { promise, resolve } = Promise.withResolvers<Outcome>();
	try {
		execFile(binary, args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
			// error.message repeats the full argv, wake text included; the receipt keeps Herdr's own first line instead.
			const said = `${stderr || ""}${stdout || ""}`.trim().split("\n")[0] ?? "";
			const detail = error?.killed
				? `herdr exceeded ${timeout}ms`
				: said || (error ? `herdr exited ${error.code ?? "abnormally"}` : "");
			resolve({ ok: !error, detail });
		});
	} catch (error) {
		// The spawn throws when the OS refuses the argv, as E2BIG for an argument past its limit.
		resolve({ ok: false, detail: `herdr not started: ${(error as NodeJS.ErrnoException).code ?? "spawn failed"}` });
	}
	return promise;
}
