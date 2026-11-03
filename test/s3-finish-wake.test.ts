// S3 · finish and wake. Every way a job ends records one terminal state, and the coordinator session that should hear
// it is woken exactly once. The coordinator is the fake engine running the real hook/wake.ts under PI_SESSION_ID; its
// fake-events.jsonl holds every wake it received. Absence is proved by order, never by waiting: a session confirms a
// wake by moving its claim to notify/delivered/<session>, and no listener injects that wake again afterwards, so once
// the delivered record exists every wake the job will cause for that session is already recorded.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	engineEvents,
	FINAL,
	git,
	jobDir,
	jobFile,
	limen,
	type Plant,
	plant,
	release,
	spawnJob,
	until,
	waitJob,
} from "./plant.ts";

const WAKE_HOOK = fileURLToPath(new URL("../hook/wake.ts", import.meta.url));
const ROUTE = ["--engine", "pi", "--provider", "p", "--model", "m", "--thinking", "high", "--detached"];
let p: Plant;
let coord = "";
const sessions: ChildProcess[] = [];

/** A coordinator session: the fake engine with the real wake hook, running `script` as PI_SESSION_ID `session`. */
function coordinator(name: string, session: string, script: string, env: Record<string, string> = {}): string {
	const dir = join(p.parent, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "task.md"), script);
	const args = ["--session-dir", join(dir, "session"), "--extension", WAKE_HOOK, `@${join(dir, "task.md")}`];
	const options = { cwd: p.root, env: { ...p.env, ...env, PI_SESSION_ID: session }, stdio: "ignore" } as const;
	sessions.push(spawn(join(p.bin, "pi"), args, options));
	return dir;
}
/** A detached job running the fake-engine `script`, spawned from the `coord` session unless `env` says otherwise. */
function job(
	script: string,
	label: string,
	flags: readonly string[] = [],
	env: Record<string, string> = { PI_SESSION_ID: "coord" },
): string {
	return spawnJob(p, script, [...ROUTE, "--label", label, ...flags], { env });
}
/** The wakes a session received for job `id`, with their position in its event record. */
function wakes(dir: string, id: string) {
	return engineEvents(dir).flatMap((event, index) =>
		event.text?.startsWith("Limen job") && event.text.includes(id) ? [{ ...event, index }] : [],
	);
}
const delivered = (ids: readonly string[], session = "coord") =>
	until(join(p.root, ".limen", "jobs"), () =>
		ids.every((id) => existsSync(join(jobDir(p, id), "notify", "delivered", session))),
	);
/** Each job woke the listeners of its session exactly once, and its wake names the job's label and recorded state. */
function wokeOnce(ids: Readonly<Record<string, string>>, listeners: readonly string[]): void {
	for (const [name, id] of Object.entries(ids)) {
		const [wake, ...extra] = listeners.flatMap((dir) => wakes(dir, id));
		assert.equal(extra.length, 0, `${name} woke its session once`);
		const named = wake?.text?.includes(jobFile(p, id, "label")) && wake.text.includes(jobFile(p, id, "state"));
		assert.ok(named, `${name} wake names its label and state`);
	}
}

before(async () => {
	p = await plant();
	coord = coordinator("coord", "coord", "block\n/limen off\nblock\n/limen on\nblock\n");
});
after(async () => {
	for (const session of sessions) {
		session.kill();
	}
	await p.cleanup();
});

test("a job that ends done, failed or on a provider error wakes its session once, with two listeners on that session", async () => {
	const second = coordinator("second", "coord", "block\n");
	const handoff = `${FINAL.line.replace("Note check:", "Report:")}\\n## Note check\\n- Hold: not proven. No run.\\n- Cap: proven. \`npm test\``;
	const ids = {
		done: job(`commit\nfinish\nfinish ${handoff}`, "a done"),
		failed: job("fail 7", "a failed"),
		provider: job(`say ${FINAL.line}\ncommit\nerror`, "a provider error"),
	};
	const states = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, waitJob(p, id)]));
	await delivered(Object.values(ids));
	// Every wake is recorded now. The second listener ends, so only the coord session hears the next jobs.
	await release(second);
	await until(second, () => engineEvents(second).some((event) => event.event === "exit"));
	assert.deepEqual(states, { done: "done", failed: "failed", provider: "failed" });
	assert.equal(jobFile(p, ids.done, "log").split("note check sent").length, 2);
	// A provider error after a commit fails the job (967ab4b recorded it as done) and keeps the commit on its branch.
	assert.equal(git(p.root, "rev-list", "--count", `main..${jobFile(p, ids.provider, "branch")}`), "1");
	wokeOnce(ids, [coord, second]);
	const [failed = "", done = "", provider = ""] = [ids.failed, ids.done, ids.provider].map(
		(id) => [coord, second].flatMap((dir) => wakes(dir, id))[0]?.text,
	);
	assert.match(failed, /produced nothing/);
	assert.doesNotMatch(done, /produced nothing/);
	assert.ok(done.includes(`Final message:\n${handoff.replaceAll("\\n", "\n")}\n\n`));
	assert.equal(jobFile(p, ids.provider, "result"), FINAL.text); // stdout cut it inside letters of 2, 3 and 4 bytes
	assert.ok(provider.includes(`Final message:\n${FINAL.text}\n\n`));
	// Its open note checks reach the wake, one line each, and it is not a plain done; `npm test` never ran.
	assert.match(done, /is done with open checks \(.+\n\nOpen checks:\n- Hold: not proven\. No run\.\n\n/);
});

test("stop, timeout, the tool cap and a stalled tool each end a job once and wake its session once; 80% of a timeout steers once; the plant's limits file yields to an env var", async () => {
	writeFileSync(join(p.root, ".agents/limen/limits.json"), '{"prepare":"1s","toolStall":"2s","timeout":"2h"}\n');
	const ids = {
		stopped: job("block", "b stopped"),
		timeout: job("block", "b timeout", ["--timeout", "3s"]),
		cap: job("tool ls\nblock", "b tool cap", [], { PI_SESSION_ID: "coord", LIMEN_MAX_TOOL_CALLS: "1" }),
		stall: job("idle", "b stall", ["--prepare", "sleep 30"]),
		kept: job("say kept", "b kept", ["--prepare", "sleep 2"], { PI_SESSION_ID: "coord", LIMEN_PREPARE_MS: "60000" }),
	};
	await until(jobDir(p, ids.stopped), () => existsSync(join(jobDir(p, ids.stopped), "fake-blocked-1")));
	assert.equal(limen(p, ["stop", ids.stopped, "test stop"]).status, 0);
	const states = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, waitJob(p, id)]));
	assert.deepEqual(states, { stopped: "stopped", timeout: "failed", cap: "failed", stall: "failed", kept: "done" });
	assert.equal(jobFile(p, ids.timeout, "log").match(/steered: 1 min left before the timeout: /g)?.length, 1);
	assert.match(jobFile(p, ids.stall, "log"), /timeout is not a limit.*timed out after 1 s.*CPU-idle child for 2s/s);
	assert.doesNotMatch(jobFile(p, ids.kept, "log"), /prepare failed/);
	// One terminal line each; a stop logs two until F928 lands (stop.ts's 25 ms grace races the finalize).
	for (const id of [ids.timeout, ids.cap, ids.stall]) {
		assert.equal(jobFile(p, id, "log").match(/\] (?:done|failed|stopped):/g)?.length, 1, id);
	}
	await delivered(Object.values(ids));
	wokeOnce(ids, [coord]);
});

test("wakes of jobs that end while muted arrive after /limen on, in one turn, each exactly once (F042)", async () => {
	await release(coord, 1);
	await until(coord, () => existsSync(join(coord, "fake-blocked-2")));
	const muted = [job("say one", "m one"), job("say two", "m two")];
	for (const id of muted) {
		assert.equal(waitJob(p, id), "done");
	}
	await release(coord, 2);
	await delivered(muted);
	const on = engineEvents(coord).findIndex(
		(event) => event.event === "notify" && event.text?.startsWith("limen wake on"),
	);
	assert.ok(on >= 0, "the session saw /limen on");
	const heard = muted.map((id) => wakes(coord, id));
	// Before 7e43d23 the batched turn confirmed only its last wake, and the first was injected again.
	assert.equal(heard.map((list) => list.length).join(), "1,1");
	const afterOn = heard.every(([wake]) => (wake?.index ?? -1) > on);
	assert.ok(afterOn, "muted wakes arrive only after /limen on");
	// The first idle inject opens a turn; the second joins it as a follow-up, so both enter one turn.
	assert.equal(heard.map(([wake]) => wake?.event).join(), "user,followUp");
});

test("limen watch and unwatch move a job's wake to another session", async () => {
	const other = coordinator("other", "other", "block\n");
	const moved = job("block", "w moved");
	assert.equal(limen(p, ["watch", moved]).status, 1, "watch needs a session to route the wake to");
	assert.equal(limen(p, ["watch", moved], { env: { PI_SESSION_ID: "other" } }).status, 0);
	assert.equal(limen(p, ["unwatch", moved], { env: { PI_SESSION_ID: "coord" } }).status, 0);
	await release(jobDir(p, moved));
	assert.equal(waitJob(p, moved), "done");
	await delivered([moved], "other");
	// The coord session visits jobs in id order in one sweep; a misrouted wake for `moved` lands before the barrier's.
	const barrier = job("say ok", "y barrier");
	await delivered([barrier]);
	assert.deepEqual([wakes(other, moved).length, wakes(coord, moved).length], [1, 0]);
});

test("a held gate queues jobs by priority and a rule's start priority holds the rest; a queued job tells its session once that it started, then its finish wakes it once", async () => {
	const reading = join(p.parent, "start-reading.json");
	writeFileSync(reading, '{"cpuIdle":10,"memoryFree":80}');
	const pipe = join(p.parent, "timed-reading");
	execFileSync("mkfifo", [pipe]); // timed reads its load from this pipe: each sample it takes waits for the test
	// A dead wrapper and a stopped job at the head hold nothing; a 2s timeout counts from engine start, not the queue.
	const [dead = "", stopped = ""] = ["q dead", "q stopped"].map((label) => job("say no", label, ["--priority", "1"]));
	const timed = job("say timed", "q timed", ["--timeout", "2s"], { PI_SESSION_ID: "coord", LIMEN_START_READING: pipe });
	const run = limen(p, ["spawn", ...ROUTE, "--label", "late", "block"], { env: { PI_SESSION_ID: "coord" } });
	assert.match(run.stdout, /\nqueued late: CPU 10% idle \(gate 25%\), memory 80% free \(gate 20%\), 3 ahead\n\S+\n$/);
	const later = run.stdout.trim().split("\n").at(-1) ?? "";
	const urgent = job("block", "q urgent", ["--priority", "1"]);
	process.kill(Number(jobFile(p, dead, "pid")), "SIGKILL");
	assert.equal(limen(p, ["stop", stopped, "not needed"]).stdout, `stopped ${stopped}: not needed\n`);
	await until(jobDir(p, timed), () => Date.now() - Date.parse(jobFile(p, timed, "started-at")) > 2_500);
	// The budget: urgent starts under a start priority 2 rule; a change to 1 while timed samples must still hold timed.
	limen(p, ["rule", "set", "week", "--until", "1h", "--start-priority", "2", "Low"]);
	writeFileSync(reading, '{"cpuIdle":90,"memoryFree":80}');
	const head = await open(pipe, "w"); // timed, the head once urgent started, samples the load
	assert.match(limen(p, ["rule", "set", "week", "--until", "1h", "--start-priority", "1", "Low"]).stdout, /changed/);
	await head.writeFile("{}").finally(() => head.close());
	await until(jobDir(p, later), () => /"held by rule week until .+"ahead":1/.test(jobFile(p, later, "queued")));
	const held = "held by rule week until [^\\n]+ \\(start priority 1\\)";
	const shown = limen(p, ["jobs", later], { env: { LIMEN_REAP_CONFIRM_MS: "1" } }).stdout;
	assert.match(shown, new RegExp(` · queued · waiting \\d+s: ${held}, 1 ahead · `));
	assert.match(limen(p, ["queue"]).stdout, new RegExp(`1\\. ${timed} .+\\n   ${held}\\n.+\\n2\\. ${later} `));
	assert.ok(!engineEvents(coord).some((event) => event.text?.startsWith("limen: late started")), "no toast yet");
	sessions[0]?.kill("SIGSTOP"); // The quick job ends while its listener sleeps, before its start notice.
	assert.match(limen(p, ["rule", "end", "week"]).stdout, /^rule week ended/);
	await writeFile(pipe, "{}"); // timed, the head again, samples once more
	assert.equal(waitJob(p, timed), "done");
	sessions[0]?.kill("SIGCONT");
	const noticed = (id: string) => existsSync(join(jobDir(p, id), "notify/delivered/_start.coord"));
	await until(jobDir(p, later), () => noticed(later) && noticed(urgent));
	await Promise.all([later, urgent].map((id) => release(jobDir(p, id))));
	assert.equal([later, urgent, stopped].map((id) => waitJob(p, id)).join(), "done,done,stopped");
	const started = (id: string) => /\[limen (\S+)\] start queue: started/.exec(jobFile(p, id, "log"))?.[1] ?? "";
	assert.ok(started(urgent) < started(timed) && started(timed) < started(later), "priority, then queue time");
	assert.equal(jobFile(p, stopped, "log").match(/\] stopped:/g)?.length, 1, "a queued stop finalizes once");
	await delivered([later, urgent, timed]);
	// The start notice is its own receipt and comes first; a job that ended before it carries its line in the finish wake.
	const heard = [later, urgent, timed].map((id) => wakes(coord, id).map((w) => w.text?.includes(") started after ")));
	assert.deepEqual(heard.flat(), [true, false, true, false, true]);
});

test("an idle owner hears a job whose session is gone through one fallback wake once its grace passes", async () => {
	const owner = coordinator("owner", "owner", "block\n", { LIMEN_WAKE_FALLBACK_MS: "1500" });
	await delivered([job("say mine", "f owned", [], { PI_SESSION_ID: "owner" })], "owner");
	const orphan = job("say gone", "f orphan", [], { PI_SESSION_ID: "gone" });
	await delivered([orphan], "_fallback");
	wokeOnce({ orphan }, [owner]);
});
