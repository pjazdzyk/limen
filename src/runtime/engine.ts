import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { claudeArgv, preflightClaude } from "./claude.ts";

export type EngineId = "pi" | "omp" | "devin" | "claude";
export type EngineProfile = {
	readonly id: EngineId;
	readonly binaryEnv: "LIMEN_PI" | "LIMEN_OMP" | "LIMEN_DEVIN" | "LIMEN_CLAUDE";
	readonly binaryDefault: EngineId;
	readonly herdrKind: EngineId;
	readonly projectTrust: boolean;
	readonly toolYolo: boolean;
	readonly sessionName: boolean;
	readonly noTitle: boolean;
	readonly authCheck: boolean;
};
export type EngineArgv = {
	readonly jsonMode: boolean;
	readonly skillConfig?: string;
	readonly jobDir: string;
	readonly label: string;
	readonly preamble: string;
	readonly extensions: readonly string[];
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly continueValue?: string;
	readonly taskFile?: string;
	/** Claude only: the session id to start, or to resume when `continueValue` is set. */
	readonly session?: string;
};
export const ENGINES: { readonly [K in EngineId]: EngineProfile } = {
	pi: {
		id: "pi",
		binaryEnv: "LIMEN_PI",
		binaryDefault: "pi",
		herdrKind: "pi",
		projectTrust: true,
		toolYolo: false,
		sessionName: true,
		noTitle: false,
		authCheck: true,
	},
	omp: {
		id: "omp",
		binaryEnv: "LIMEN_OMP",
		binaryDefault: "omp",
		herdrKind: "omp",
		projectTrust: false,
		toolYolo: true,
		sessionName: false,
		noTitle: true,
		authCheck: false,
	},
	// A Devin job runs in Devin's cloud through its API; the `devin` CLI only lends its login and reports its version.
	devin: {
		id: "devin",
		binaryEnv: "LIMEN_DEVIN",
		binaryDefault: "devin",
		herdrKind: "devin",
		projectTrust: false,
		toolYolo: false,
		sessionName: false,
		noTitle: true,
		authCheck: false,
	},
	// The official, unmodified Claude Code binary in print mode. It authenticates itself; see runtime/claude.ts.
	claude: {
		id: "claude",
		binaryEnv: "LIMEN_CLAUDE",
		binaryDefault: "claude",
		herdrKind: "claude",
		projectTrust: false,
		toolYolo: false,
		sessionName: false,
		noTitle: false,
		authCheck: false,
	},
};
const isEngineId = (id: string): id is EngineId => id === "pi" || id === "omp" || id === "devin" || id === "claude";
export function engineProfile(id: string): EngineProfile {
	if (isEngineId(id)) {
		return ENGINES[id];
	}
	throw new Error(`unknown engine ${id}`);
}
export function resolveSpawnEngine(flag?: string): EngineProfile {
	const raw = (flag ?? process.env.LIMEN_ENGINE)?.trim() || "pi";
	if (isEngineId(raw)) {
		return ENGINES[raw];
	}
	throw new Error("--engine must be pi, omp, devin or claude");
}
export function engineBinary(profile: EngineProfile): string {
	return process.env[profile.binaryEnv] ?? profile.binaryDefault;
}
export async function jobProfile(jobDir: string): Promise<EngineProfile> {
	return engineProfile((await readFile(`${jobDir}/engine`, "utf8").catch(() => "pi")).trim() || "pi");
}
// Package fallback when neither --model nor the role's environment variable names a model. Claude Code takes
// its own model names, so a claude job reads LIMEN_CLAUDE_MODEL instead and falls back to the `sonnet` alias.
export function defaultModel(review: boolean, engine: EngineId = "omp"): string {
	if (engine === "claude") {
		return process.env.LIMEN_CLAUDE_MODEL?.trim() || "sonnet";
	}
	return process.env[review ? "LIMEN_REVIEWER_MODEL" : "LIMEN_WORKER_MODEL"]?.trim() || "openai-codex/gpt-6-astra:high";
}
export function preflightEngine(profile: EngineProfile, model?: string, provider?: string): void {
	const route = engineRoute(profile, provider, model);
	if (profile.id === "omp" && provider === BRIDGE && !route.bridged) {
		const name = model?.split("/").at(-1) || "<model>";
		throw new Error(
			`OMP cannot serve --provider ${BRIDGE} --model ${model ?? "<none>"}; pass --model ${BRIDGE}/${name}`,
		);
	}
	if (route.bridged && !bridgePath(profile)) {
		const home =
			profile.id === "omp"
				? "the OMP bridge at ~/.omp/local/pi-claude-bridge"
				: "a pi-claude-bridge package (pi install) under ~/.pi/agent/npm";
		throw new Error(`--model ${route.model} needs ${home}, which is missing`);
	}
	if (!(process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(`${dir}/${profile.binaryDefault}`))) {
		throw new Error(
			`${profile.binaryDefault} is not on PATH; install it, or pass --engine ${profile.id === "omp" ? "pi" : "omp"}`,
		);
	}
	if (profile.id === "claude") {
		preflightClaude(engineBinary(profile));
		return;
	}
	// The bridge signs in through Claude Code, so Pi's own auth store has no say over a bridged route.
	if (!profile.authCheck || route.bridged || process.env.LIMEN_PREFLIGHT !== "auth") {
		return;
	}
	const result = spawnSync(
		engineBinary(profile),
		["auth", "check", ...(provider ? ["--provider", provider] : []), ...(model ? ["--model", model] : [])],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0) {
		throw new Error(
			(result.stderr || result.stdout || result.error?.message || "pi auth check failed").trim() ||
				"pi auth check failed",
		);
	}
}
type LegacySkill = { name: string; source: string; flat: boolean };
/** One `.pi/skills` entry as a skill; undefined when it is no skill or `.agents/skills` or `.omp/skills` has its name. */
async function legacySkill(worktree: string, legacy: string, entry: string): Promise<LegacySkill | undefined> {
	const source = join(legacy, entry);
	const info = await stat(source).catch(() => undefined);
	if (!info) {
		return;
	}
	const flat = info.isFile() && entry.endsWith(".md");
	const name = flat ? basename(entry, ".md") : entry;
	if (!name) {
		return;
	}
	if (!flat) {
		if (!info.isDirectory()) {
			return;
		}
		const skillFile = await stat(join(source, "SKILL.md")).catch(() => undefined);
		if (!skillFile?.isFile()) {
			return;
		}
	}
	if (
		(await stat(join(worktree, ".agents/skills", name, "SKILL.md")).catch(() => undefined))?.isFile() ||
		(await stat(join(worktree, ".omp/skills", name, "SKILL.md")).catch(() => undefined))?.isFile()
	) {
		return;
	}
	return { name, source, flat };
}
// Keep Pi's source tree untouched. Rebuild the job-local view on each launch
// so resumed branches and newly added legacy skills get a fresh inventory.
export async function prepareSkillConfig(worktree: string, jobDir: string): Promise<string | undefined> {
	const legacy = join(worktree, ".pi/skills");
	const entries = await readdir(legacy).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return [];
		}
		throw error;
	});
	const skills: LegacySkill[] = [];
	for (const entry of entries) {
		const skill = await legacySkill(worktree, legacy, entry);
		if (!skill) {
			continue;
		}
		// A directory skill carries its supporting files and takes priority over a flat duplicate.
		if (skills.some((kept) => kept.name === skill.name && !kept.flat)) {
			continue;
		}
		const index = skills.findIndex((kept) => kept.name === skill.name);
		if (index !== -1) {
			skills.splice(index, 1);
		}
		skills.push(skill);
	}
	const view = join(jobDir, "skills");
	await rm(view, { recursive: true, force: true });
	if (!skills.length) {
		return;
	}
	await mkdir(view);
	for (const skill of skills) {
		const target = join(view, skill.name);
		if (skill.flat) {
			await mkdir(target);
			await symlink(skill.source, join(target, "SKILL.md"));
		} else {
			await symlink(skill.source, target);
		}
	}
	const configured = spawnSync(engineBinary(ENGINES.omp), ["config", "get", "skills.customDirectories", "--json"], {
		cwd: worktree,
		encoding: "utf8",
	});
	if (configured.error || configured.status !== 0) {
		throw new Error(
			`could not read OMP skill config: ${configured.stderr || configured.error?.message || configured.status}`,
		);
	}
	const parsed: unknown = configured.stdout.trim() ? JSON.parse(configured.stdout) : { value: [] };
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("value" in parsed) ||
		!Array.isArray(parsed.value) ||
		!parsed.value.every((path) => typeof path === "string")
	) {
		throw new Error("invalid OMP skills.customDirectories");
	}
	const config = join(jobDir, "skills-config.yml");
	await writeFile(
		config,
		`skills:\n  customDirectories:\n${[...parsed.value, view].map((path) => `    - ${JSON.stringify(path)}\n`).join("")}`,
	);
	return config;
}

export function argvFor(profile: EngineProfile, slots: EngineArgv): string[] {
	if (profile.id === "claude") {
		return claudeArgv(slots);
	}
	const args: string[] = [];
	if (slots.jsonMode) {
		args.push("--mode", "json");
	}
	if (profile.projectTrust) {
		args.push("--approve");
	}
	if (profile.toolYolo) {
		args.push("--auto-approve");
	}
	args.push("--no-extensions", "--session-dir", `${slots.jobDir}/session`);
	if (profile.sessionName) {
		args.push("--name", `limen: ${slots.label}`);
	}
	if (profile.noTitle) {
		args.push("--no-title");
	}
	if (profile.id === "omp" && slots.skillConfig) {
		args.push("--config", slots.skillConfig);
	}
	args.push("--append-system-prompt", slots.preamble);
	const route = engineRoute(profile, slots.provider, slots.model);
	const bridge = route.bridged ? bridgePath(profile) : undefined;
	const named = [
		...slots.extensions,
		...(bridge ? [bridge] : []),
		...(slots.jsonMode ? [] : herdrStateExtensions(profile)),
	];
	const seen = new Set<string>();
	for (const path of named) {
		const key = profile.id === "pi" && existsSync(path) ? realpathSync(path) : path;
		if (profile.id === "pi" && seen.has(key)) {
			continue;
		}
		seen.add(key);
		args.push("--extension", path);
	}
	if (route.provider) {
		args.push("--provider", route.provider);
	}
	if (route.model) {
		args.push("--model", route.model);
	}
	if (slots.thinking) {
		args.push("--thinking", slots.thinking);
	}
	if (slots.continueValue !== undefined) {
		args.push("--continue", slots.continueValue);
	} else {
		args.push(`@${slots.taskFile}`);
	}
	return args;
}

const BRIDGE = "pi-claude";

// Both engines reach Claude Code through a bridge extension that serves `pi-claude/…` ids. Pi takes the provider
// as given. OMP has no `pi-claude` provider and chooses its bridge by the model id alone, so on OMP
// `--provider pi-claude --model claude-opus-5-5` means `--model pi-claude/claude-opus-5-5`, and a bridged
// provider stays in the job record but not on argv.
export function engineRoute(
	profile: EngineProfile,
	provider: string | undefined,
	model: string | undefined,
): { readonly provider: string | undefined; readonly model: string | undefined; readonly bridged: boolean } {
	if (profile.id === "pi") {
		return { provider, model, bridged: provider === BRIDGE || !!model?.startsWith(`${BRIDGE}/`) };
	}
	if (profile.id !== "omp") {
		return { provider, model, bridged: false };
	}
	const full = provider === BRIDGE && model && !model.includes("/") ? `${BRIDGE}/${model}` : model;
	const bridged = !!full?.startsWith(`${BRIDGE}/`);
	return { provider: bridged ? undefined : provider, model: full, bridged };
}

// `--no-extensions` hides the bridge. Name it explicitly so the model resolves while other user
// extensions stay off. OMP loads its local port; Pi loads the bridge package it installed, scoped or not.
function bridgePath(profile: EngineProfile): string | undefined {
	let candidates = [join(homedir(), ".omp", "local", "pi-claude-bridge")];
	if (profile.id === "pi") {
		const modules = join(homedir(), ".pi", "agent", "npm", "node_modules");
		const scopes = existsSync(modules) ? readdirSync(modules).filter((name) => name.startsWith("@")) : [];
		candidates = ["", ...scopes].map((scope) => join(modules, scope, "pi-claude-bridge"));
	}
	const found = candidates.find((path) => existsSync(path));
	return found ? realpathSync(found) : undefined;
}

// `--no-extensions` also hides Herdr's state extension, so a hosted pane falls back to screen
// detection and reads the working agent as idle. Name the Herdr-managed file by its marker.
function herdrStateExtensions(profile: EngineProfile): string[] {
	const dir = join(homedir(), `.${profile.id}`, "agent", "extensions");
	const files = existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.endsWith(".ts"))
				.sort()
		: [];
	const marker = new RegExp(`^// HERDR_INTEGRATION_ID=${profile.herdrKind}$`, "m");
	return files.map((name) => join(dir, name)).filter((path) => marker.test(readFileSync(path, "utf8")));
}
