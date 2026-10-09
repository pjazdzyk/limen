import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { herdrAvailable } from "../integrations/herdr.ts";
import type { GroupIdentity, GroupMember, GroupRun, TeamRoute } from "../job/group-cabinet.ts";
import {
	groupIdentity,
	groupLock,
	groupPath,
	leadHookLive,
	leadSession,
	memberLive,
	readRun,
	runs,
	saveJson,
	startGroupAdvance,
	teamRoute,
} from "../job/group-cabinet.ts";
import { acceptBatch, acceptTransport, groupEvents, publishEvent, syncLifecycle } from "../job/group-events.ts";
import { roundNames, routeFlags } from "../job/group-packet.ts";
import { parseDuration, SESSION_ID } from "../job/job.ts";
import { commitHasFile, headCommit, limenRoot, repoRoot, worktreeState } from "../project/git.ts";
import { type PlanningSource, planningSource, privatePlanningFile } from "../project/planning.ts";
import { preflightEngine, resolveSpawnEngine } from "../runtime/engine.ts";
import { normalizeWorkerExtensions } from "../runtime/worker-extensions.ts";
import { parseFlags } from "./flags.ts";
import { advanceGroup, teamJobLabel } from "./group-rounds.ts";
import { herdrWakePane, spawnCommand } from "./spawn.ts";
import { stopCommand } from "./stop.ts";

const WAIT_CAP_MS = 20_000;
const WRAP_UP_RESERVE_MS = 60_000;
const DEFAULT_TIMEOUT = "90m";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

type GroupStartOptions = {
	readonly routes: readonly TeamRoute[];
	readonly rounds: readonly string[];
	readonly workers: string;
	readonly timeout: string;
	readonly extensions: readonly string[];
	readonly teamSelections: Readonly<Record<string, readonly string[]>>;
	readonly mode: GroupRun["mode"];
};
const GROUP_START =
	"run limen group start FEATURE --team ENGINE:PROVIDER/MODEL:THINKING (once per team) [--rounds draft,critique,final] [--workers N] [--timeout 90m]";
const INVALID_START = `invalid or repeated group start argument; ${GROUP_START}`;
const INVALID_TEAM = `invalid --team; ${GROUP_START}, for example --team omp:openai-codex/gpt-6.1-sol:high`;
const BOTH_MODES =
	"choose either hosted tabs or detached jobs, not both; run limen group start FEATURE with one of --tab or --detached";

function parseGroupStartArgs(args: readonly string[]): GroupStartOptions {
	const { values } = parseFlags(
		args.slice(1),
		{
			team: { type: "string", multiple: true },
			rounds: { type: "string" },
			workers: { type: "string" },
			timeout: { type: "string" },
			extension: { type: "string", multiple: true },
			"team-extension": { type: "string", multiple: true },
			tab: { type: "boolean" },
			detached: { type: "boolean" },
		} as const,
		{
			// Every word after the feature is a flag; a known one with a bad value reads as invalid, not unknown.
			unknown: (word, next) =>
				word && next && !next.startsWith("--") ? `unknown group flag ${word}; ${GROUP_START}` : INVALID_START,
			missing: (flag) => {
				if (flag === "--team") {
					return INVALID_TEAM;
				}
				return flag === "--extension" || flag === "--team-extension" ? `${flag} requires a value` : INVALID_START;
			},
			repeated: (flag) => (flag === "--tab" || flag === "--detached" ? BOTH_MODES : INVALID_START),
			positionals: false,
			endOfFlags: false,
		},
	);
	if (values.tab && values.detached) {
		throw new Error(BOTH_MODES);
	}
	let mode: GroupRun["mode"] = "auto";
	if (values.tab) {
		mode = "tab";
	}
	if (values.detached) {
		mode = "detached";
	}
	return {
		routes: (values.team ?? []).map(teamRouteFlag),
		rounds: (values.rounds ?? "draft").split(",").map((name) => name.trim()),
		workers: values.workers ?? "0",
		timeout: values.timeout ?? DEFAULT_TIMEOUT,
		extensions: values.extension ?? [],
		teamSelections: teamExtensionPaths(values["team-extension"] ?? []),
		mode,
	};
}
/** `--team ENGINE:PROVIDER/MODEL:THINKING`; the model may hold `/` and `:`, the reasoning level is last. */
function teamRouteFlag(value: string): TeamRoute {
	const route = /^([^:/\s]+):([^:/\s]+)\/(\S+):([a-z]+)$/.exec(value);
	if (!route?.[1] || !route[2] || !route[3] || !route[4] || !LEVELS.includes(route[4])) {
		throw new Error(`${INVALID_TEAM}; the reasoning level is one of ${LEVELS.join(", ")}`);
	}
	const engine = resolveSpawnEngine(route[1]).id;
	if (engine === "claude") {
		throw new Error("groups need Limen's group hook inside each engine; claude cannot load it, use engine omp or pi");
	}
	return { engine, provider: route[2], model: route[3], thinking: route[4] };
}
function teamExtensionPaths(values: readonly string[]): Record<string, string[]> {
	const paths: Record<string, string[]> = {};
	for (const value of values) {
		const selection = /^(team-[1-9]\d*)=(.+)$/.exec(value);
		if (!selection?.[1] || !selection[2]) {
			throw new Error("invalid --team-extension; use team-N=PATH");
		}
		paths[selection[1]] = [...(paths[selection[1]] ?? []), selection[2]];
	}
	return paths;
}
type GroupSettings = {
	readonly teams: string[];
	readonly routes: Record<string, TeamRoute>;
	readonly rounds: string[];
	readonly workersPerTeam: number;
	readonly timeout: number;
};
type GroupActivation = {
	readonly feature: string;
	readonly source: PlanningSource;
	readonly lead: string;
	readonly settings: GroupSettings;
	readonly options: GroupStartOptions;
};
export async function startGroup(args: readonly string[], cwd: string): Promise<GroupRun> {
	if (process.env.LIMEN_GROUP_ID || process.env.LIMEN_JOB === "1") {
		throw new Error(
			"only the owner-facing lead may start a group: run limen group start from the plant's interactive Herdr coordinator pane (LIMEN_COORDINATOR=1) with hook/group-peer.ts loaded — a hosted limen job (LIMEN_JOB=1) cannot register as lead or start groups",
		);
	}
	const featureArgument = args[0];
	if (!featureArgument || featureArgument.startsWith("--")) {
		throw new Error(
			`group start has no feature directory; ${GROUP_START.replace("FEATURE", "spec/features/active/FEATURE")}`,
		);
	}
	const options = parseGroupStartArgs(args);
	// Deliberately ignore inherited LIMEN_CONTEXT_ROOT for new activation.
	const root = repoRoot(cwd);
	const feature = groupFeature(root, cwd, featureArgument);
	const source = await groupPlanningSource(root, feature, featureArgument);
	const lead = await liveGroupLead(root);
	const settings = await groupSettings(options);
	await checkGroupPacket(root, feature, settings.teams, source);
	const activated = await activateGroup(root, cwd, { feature, source, lead, settings, options });
	if (activated.created) {
		await spawnTeamCoordinators(root, activated.run);
	}
	return readRun(root, activated.run.id);
}
function groupFeature(root: string, cwd: string, featureArgument: string): string {
	const feature = relative(root, resolve(cwd, featureArgument));
	if (feature.startsWith("..") || !feature.startsWith("spec/features/")) {
		throw new Error(
			"feature must be inside this repository's spec/features; run limen group start spec/features/active/FEATURE with the group settings",
		);
	}
	return feature;
}
/** A repeated start resumes the feature's open run, so it keeps that run's planning source. */
async function groupPlanningSource(root: string, feature: string, featureArgument: string): Promise<PlanningSource> {
	const latest = (await runs(root)).filter((run) => run.feature === feature).at(-1);
	const open = latest && !latest.stopped && !latest.closed ? latest : undefined;
	const source = open ? (open.planningSource ?? "committed") : planningSource(root);
	if (source === "private" && featureArgument.split(/[\\/]/).includes("..")) {
		throw new Error(
			"private planning feature path must not contain '..'; run limen group start spec/features/active/FEATURE from the project root",
		);
	}
	return source;
}
/** The interactive coordinator registered as lead, whose group-peer hook is alive. */
async function liveGroupLead(root: string): Promise<string> {
	const lead = (await leadSession(root)) ?? "";
	if (!SESSION_ID.test(lead)) {
		throw new Error(
			"group start requires the interactive Herdr coordinator pane (LIMEN_COORDINATOR=1) with hook/group-peer.ts loaded and registered under .limen/group-leads — reload that pane after updating the package; a hosted limen job never registers as lead",
		);
	}
	if (!(await leadHookLive(root, lead))) {
		throw new Error(
			`group lead hook is not running in this pane: .limen/group-leads/${lead} names no live process refreshed by hook/group-peer.ts in the last 30 seconds. Reload this interactive Herdr coordinator (LIMEN_COORDINATOR=1) with the Limen package hooks, including hook/group-peer.ts, and retry. Do not write .limen/group-leads by hand: without the hook, team results never reach this pane — and do not spawn a hosted job as lead`,
		);
	}
	return lead;
}
/** The roster, routes, rounds, allowance and deadline, checked before anything is written. */
async function groupSettings({ routes, rounds, workers, timeout, mode }: GroupStartOptions): Promise<GroupSettings> {
	if (!routes.length) {
		throw new Error(`group start has no team; ${GROUP_START}`);
	}
	const teams = routes.map((_, index) => `team-${index + 1}`);
	const known = await roundNames();
	for (const [index, name] of rounds.entries()) {
		if (!known.includes(name)) {
			throw new Error(`unknown group round ${JSON.stringify(name)}; use rounds from ${known.join(", ")}`);
		}
		if (name === "final" && index !== rounds.length - 1) {
			throw new Error("the final round writes the group's one result, so it must be the last round");
		}
	}
	if (!/^\d+$/.test(workers) || !Number.isSafeInteger(Number(workers))) {
		throw new Error(`--workers must be a whole number of workers per team; ${GROUP_START}`);
	}
	const timeoutMs = parseDuration(timeout);
	if (timeoutMs <= WRAP_UP_RESERVE_MS) {
		throw new Error(
			`group timeout must leave a ${WRAP_UP_RESERVE_MS / 1000}-second wrap-up reserve; run limen group start FEATURE with --timeout above 1m`,
		);
	}
	if (mode === "tab" && !herdrAvailable()) {
		throw new Error(
			"hosted group requires Herdr; run limen group start FEATURE --detached with the other group settings, or return to Herdr",
		);
	}
	return {
		teams,
		routes: Object.fromEntries(teams.map((team, index) => [team, routes[index] as TeamRoute])),
		rounds: [...rounds],
		workersPerTeam: Number(workers),
		timeout: timeoutMs,
	};
}
/** The ticket must exist; a brief and approach notes are optional. Committed at HEAD, or readable inside the root when private. */
async function checkGroupPacket(
	root: string,
	feature: string,
	teams: readonly string[],
	source: PlanningSource,
): Promise<void> {
	const ticket = `${feature}/ticket.md`;
	if (!existsSync(`${root}/${ticket}`)) {
		throw new Error(`group packet is missing ${ticket}; create it, then run limen group start ${feature}`);
	}
	for (const path of [
		ticket,
		`${feature}/group/brief.md`,
		...teams.map((team) => `${feature}/group/teams/${team}.md`),
	]) {
		if (!existsSync(`${root}/${path}`)) {
			continue;
		}
		if (source === "private") {
			await privatePlanningFile(root, path);
		} else if (!commitHasFile(root, headCommit(root), path)) {
			throw new Error(`group packet ${path} is not committed; run git add ${path} and commit before starting`);
		}
	}
}
/** Under the cabinet lock: resume the feature's open run, or write a new run once every prior run has ended. */
async function activateGroup(
	root: string,
	cwd: string,
	activation: GroupActivation,
): Promise<{ run: GroupRun; created: boolean }> {
	const { feature, options, settings } = activation;
	return groupLock(`${root}/.limen/groups`, async () => {
		const previous = (await runs(root)).filter((run) => run.feature === feature);
		const latest = previous.at(-1);
		// A finished group still holds its result for the lead; only stop or close makes room for a new paid run.
		if (latest && !latest.stopped && !latest.closed) {
			return { run: latest, created: false };
		}
		await assertPriorRunsEnded(root, previous);
		for (const team of Object.keys(options.teamSelections)) {
			if (!settings.teams.includes(team)) {
				throw new Error(`--team-extension names ${team}, which is not in the roster`);
			}
		}
		const teamExtensions = await teamExtensionPathsByTeam(settings, options, cwd);
		for (const route of Object.values(settings.routes)) {
			preflightEngine(resolveSpawnEngine(route.engine), route.model, route.provider);
		}
		const run = newGroupRun(root, activation, teamExtensions);
		await mkdir(groupPath(run));
		await saveJson(`${groupPath(run)}/run.json`, run);
		return { run, created: true };
	});
}
async function assertPriorRunsEnded(root: string, previous: readonly GroupRun[]): Promise<void> {
	for (const prior of previous) {
		for (const member of prior.members) {
			const live = await memberLive(root, member);
			if (live) {
				throw new Error(
					`group ${prior.feature} (${prior.id}): ${member.team} ${member.role} (${member.id}) is not over (${live}); run limen group status ${prior.id}`,
				);
			}
		}
	}
}
async function teamExtensionPathsByTeam(
	settings: GroupSettings,
	options: GroupStartOptions,
	cwd: string,
): Promise<Record<string, string[]>> {
	const teamExtensions: Record<string, string[]> = {};
	for (const team of settings.teams) {
		const selected = [...options.extensions, ...(options.teamSelections[team] ?? [])];
		const engine = resolveSpawnEngine(settings.routes[team]?.engine).id;
		if (selected.length && engine !== "pi") {
			throw new Error("--extension is supported only for Pi workers in a group; use engine pi for that team");
		}
		teamExtensions[team] = await normalizeWorkerExtensions(selected, cwd, engine);
	}
	return teamExtensions;
}
function newGroupRun(
	root: string,
	{ feature, source, lead, settings, options }: GroupActivation,
	teamExtensions: Record<string, string[]>,
): GroupRun {
	const leadPane = herdrWakePane(undefined);
	return {
		id: randomUUID(),
		root,
		feature,
		planningSource: source,
		lead,
		...(leadPane ? { leadPane } : {}),
		startedAt: Date.now(),
		teams: settings.teams,
		routes: settings.routes,
		workersPerTeam: settings.workersPerTeam,
		rounds: settings.rounds,
		round: 0,
		deadline: Date.now() + settings.timeout,
		reserveMs: WRAP_UP_RESERVE_MS,
		stopped: false,
		closed: false,
		mode: options.mode,
		members: [],
		teamExtensions,
	};
}
/** Each team's first-round job. A failed launch is recorded and ends the start. */
async function spawnTeamCoordinators(root: string, run: GroupRun): Promise<void> {
	const ticket = run.planningSource === "private" ? `${root}/${run.feature}/ticket.md` : `${run.feature}/ticket.md`;
	for (const team of run.teams) {
		const route = teamRoute(run, team);
		try {
			await spawnCommand(
				[
					`Work the ticket as ${team} of the group. Ticket: ${ticket}`,
					"--label",
					teamJobLabel(run, team, 0),
					...routeFlags(route).split(" "),
					...(run.mode === "auto" ? [] : [`--${run.mode}`]),
				],
				root,
				{ run, team },
			);
		} catch (error) {
			await saveJson(`${groupPath(run)}/activation-error.json`, {
				team,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new Error(
				`group ${run.feature} (${run.id}) started only part of its roster: ${error instanceof Error ? error.message : String(error)}; run limen group stop ${run.id} before starting a new run`,
			);
		}
	}
}
export async function waitGroup(identity: GroupIdentity, requestedMs = WAIT_CAP_MS): Promise<string> {
	const until = Date.now() + Math.max(0, Math.min(WAIT_CAP_MS, requestedMs));
	while (true) {
		const run = await readRun(identity.run.root, identity.run.id);
		if (run.stopped || run.closed) {
			return "group stopped or closed; preserve work and return to the lead";
		}
		if (Date.now() >= (identity.member?.deadline ?? run.deadline)) {
			return "group member deadline expired";
		}
		const batch = await acceptBatch(identity, Date.now(), "skip");
		if (batch) {
			return batch.text;
		}
		if (Date.now() >= until) {
			return "group wait timed out normally; re-enter bounded wait while your collaboration or children remain live";
		}
		await delay(Math.min(100, until - Date.now()));
	}
}
export async function groupCommand(args: readonly string[], cwd: string): Promise<void> {
	// Bound the actual CLI process even if a cabinet lock or filesystem operation stalls.
	if (args[0] !== "wait") {
		await runGroupCommand(args, cwd);
		return;
	}
	const cap = setTimeout(() => {
		console.log(
			`group wait timed out normally after the ${WAIT_CAP_MS / 1000}-second CLI cap; inspect any uncertain delivery receipt before retrying`,
		);
		process.exit(0);
	}, WAIT_CAP_MS);
	cap.unref();
	try {
		await runGroupCommand(args, cwd);
	} finally {
		clearTimeout(cap);
	}
}
async function runGroupCommand(args: readonly string[], cwd: string): Promise<void> {
	const [command, ...rest] = args;
	if (!command || !["start", "status", "publish", "wait", "stop", "close", "advance"].includes(command)) {
		throw new Error(
			`${command ? `unknown group command ${JSON.stringify(command)}` : "no group command supplied"}; run limen group status GROUP-ID`,
		);
	}
	if (command === "start") {
		console.log((await startGroup(rest, cwd)).id);
		return;
	}
	if (command === "advance") {
		// Internal: a finished team job starts this; it moves the group only once its round has ended.
		await advanceGroup(limenRoot(cwd), rest[0] ?? "");
		return;
	}
	const explicit = process.env.LIMEN_GROUP_ID ? undefined : rest.shift();
	const identity = await groupIdentity(cwd, explicit);
	if (!identity) {
		throw new Error("no group selected; run limen group status GROUP-ID from the lead pane");
	}
	if (command === "publish") {
		await publishGroupFinding(identity, rest);
		return;
	}
	if (command === "wait") {
		await printGroupWait(identity, rest);
		return;
	}
	if (command === "status") {
		await printGroupStatus(identity, rest);
		return;
	}
	if (identity.member) {
		throw new Error(`only the group lead may ${command}; run limen group status to inspect your group's members`);
	}
	if (command === "stop") {
		await stopGroup(identity);
		return;
	}
	if (command === "close") {
		await closeGroup(identity);
	}
}
async function publishGroupFinding(identity: GroupIdentity, rest: string[]): Promise<void> {
	let target: string | undefined;
	if (rest[0] === "--team") {
		rest.shift();
		target = rest.shift();
		if (!target) {
			throw new Error("group publish --team has no team name; run limen group publish --team team-N 'Finding: …'");
		}
	}
	console.log((await publishEvent(identity, rest.join(" "), "finding", target)).id);
}
async function printGroupWait(identity: GroupIdentity, rest: readonly string[]): Promise<void> {
	if (rest.length > 2 || (rest.length && rest[0] !== "--timeout")) {
		throw new Error("invalid group wait arguments; run limen group wait --timeout 5s");
	}
	const output = await waitGroup(identity, rest[1] ? parseDuration(rest[1]) : WAIT_CAP_MS);
	console.log(output);
	const token = /\[limen-group-delivery:([a-f0-9-]+)\]/.exec(output)?.[1];
	if (token) {
		await acceptTransport(identity, token);
	}
}
async function printGroupStatus(identity: GroupIdentity, rest: readonly string[]): Promise<void> {
	if (rest.length && (rest.length !== 1 || rest[0] !== "--json")) {
		throw new Error(`invalid group status arguments; run limen group status ${identity.run.id} --json`);
	}
	await syncLifecycle(identity.run, "skip");
	const run = await readRun(identity.run.root, identity.run.id);
	const members = await Promise.all(
		run.members.map(async (member) => ({
			...member,
			state:
				(
					await readFile(`${run.root}/.limen/jobs/${member.id}/state`, "utf8").catch(() => "no job record yet")
				).trim() || "no job record yet",
		})),
	);
	if (rest[0] === "--json") {
		console.log(
			JSON.stringify({ ...run, members, events: await groupEvents(run), receipts: await allReceipts(run) }, null, 2),
		);
		return;
	}
	const round = run.rounds[run.round] ?? "";
	console.log(`Group ${run.feature} (${run.id})`);
	console.log(
		run.finishedAt
			? `Finished after round ${run.round + 1} of ${run.rounds.length} (${round}) · result: ${groupPath(run)}/result.md`
			: `Round ${run.round + 1} of ${run.rounds.length}: ${round} · deadline ${new Date(run.deadline).toLocaleString()} · ${Math.max(0, Math.ceil((run.deadline - Date.now()) / 60_000))} minutes left`,
	);
	console.log(`Stopped: ${run.stopped ? "yes" : "no"} · Closed: ${run.closed ? "yes" : "no"}`);
	for (const member of members) {
		const place =
			member.role === "coordinator" ? `round ${(member.round ?? 0) + 1} ${run.rounds[member.round ?? 0]}` : "worker";
		console.log(`${member.team} ${place} (${member.id}): ${member.state}`);
	}
	if (!run.finishedAt && !run.stopped) {
		// A round whose last finish could not start the next one moves on here.
		startGroupAdvance(run);
	}
}
/** Blocks new launches, then stops every live member job. Throws with the members that could not be stopped. */
async function stopGroup(identity: GroupIdentity): Promise<void> {
	await groupLock(groupPath(identity.run), async () => {
		const run = await readRun(identity.run.root, identity.run.id);
		run.stopped = true;
		await saveJson(`${groupPath(run)}/run.json`, run);
	});
	const run = await groupLock(
		`${groupPath(identity.run)}/launch`,
		() => readRun(identity.run.root, identity.run.id),
		"wait",
	);
	const failures: string[] = [];
	for (const member of run.members) {
		await stopReservedSlot(run, member);
		const failure = await stopMemberJob(run, member);
		if (failure) {
			failures.push(failure);
		}
	}
	await saveJson(`${groupPath(run)}/stop-report.json`, { at: Date.now(), failures });
	if (failures.length) {
		throw new Error(
			`group ${run.feature} (${run.id}) blocked new launches but some jobs could not be stopped:\n${failures.join("\n")}\nRun limen group status ${run.id}`,
		);
	}
	console.log("group stopped; recovery work and unread events retained until close");
}
async function stopReservedSlot(run: GroupRun, member: GroupMember): Promise<void> {
	const dir = `${run.root}/.limen/jobs/${member.id}`;
	if (await readFile(`${dir}/state`, "utf8").catch(() => "")) {
		return;
	}
	// The launch lock has drained: a reserved slot without a published state cannot launch later.
	await mkdir(dir, { recursive: true });
	await writeFile(`${dir}/group`, `${run.id}\n`);
	await writeFile(`${dir}/team`, `${member.team}\n`);
	await writeFile(`${dir}/state`, "stopped\n");
	await writeFile(`${dir}/finished-at`, `${new Date().toISOString()}\n`);
}
/** Stops a live member job and waits up to 6 s for it to end. Returns why it is not confirmed stopped. */
async function stopMemberJob(run: GroupRun, member: GroupMember): Promise<string | undefined> {
	if (!(await memberLive(run.root, member))) {
		return;
	}
	try {
		await stopCommand([member.id, "group stopped by lead"], run.root);
		const until = Date.now() + 6_000;
		let live = await memberLive(run.root, member);
		while (live && Date.now() < until) {
			await delay(100);
			live = await memberLive(run.root, member);
		}
		return live ? `${member.team} ${member.role} (${member.id}): not confirmed stopped (${live})` : undefined;
	} catch (error) {
		return `${member.team} ${member.role} (${member.id}): ${error instanceof Error ? error.message : String(error)}`;
	}
}
/**
 * Marks the run closed once every member job is over and no member worktree holds uncommitted Git work. A member
 * whose worktree is gone or is no Git checkout has none; close names that folder, and prune removes it afterwards.
 */
async function closeGroup(identity: GroupIdentity): Promise<void> {
	const lost = await groupLock(
		`${groupPath(identity.run)}/launch`,
		async () => {
			const run = await readRun(identity.run.root, identity.run.id);
			const folders = new Map<string, string>();
			for (const member of run.members) {
				const name = `${member.team} ${member.role} (${member.id})`;
				const live = await memberLive(run.root, member);
				if (live) {
					throw new Error(
						`cannot close group ${run.feature} (${run.id}): ${name} is not over (${live}); run limen group stop ${run.id}`,
					);
				}
				const tree = (await readFile(`${run.root}/.limen/jobs/${member.id}/worktree`, "utf8").catch(() => "")).trim();
				const state = tree ? worktreeState(tree) : "none";
				if (state === "dirty") {
					throw new Error(
						`cannot close group ${run.feature} (${run.id}): ${name} has uncommitted work in ${tree}; run git -C ${JSON.stringify(tree)} status --short before committing or recovering that work`,
					);
				}
				if (state === "none" && existsSync(tree) && !folders.has(tree)) {
					folders.set(tree, `${name}: ${tree} is no Git checkout, so it holds no Git work; prune removes it`);
				}
			}
			run.closed = true;
			run.stopped = true;
			await saveJson(`${groupPath(run)}/run.json`, run);
			return [...folders.values()];
		},
		"wait",
	);
	for (const line of lost) {
		console.log(line);
	}
	console.log("group closed; clean member paths released for ordinary pruning");
}
async function allReceipts(run: GroupRun): Promise<unknown[]> {
	const receipts: unknown[] = [];
	for (const recipient of await readdir(`${groupPath(run)}/receipts`).catch(() => [])) {
		for (const name of await readdir(`${groupPath(run)}/receipts/${recipient}`)) {
			receipts.push(JSON.parse(await readFile(`${groupPath(run)}/receipts/${recipient}/${name}`, "utf8")));
		}
	}
	return receipts;
}
