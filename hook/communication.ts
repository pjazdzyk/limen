import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { formatDrift, inheritFile, listDrift, packageRoot, readOptional } from "../src/project/inherit.ts";
import {
	planningSource,
	privatePlanningGuidance,
	recordedPlanningSource,
	ticketPointers,
} from "../src/project/planning.ts";
import { assistantStopReason } from "../src/runtime/stream.ts";

const CONTEXT_TYPE = "limen-project-context";
const CAPABILITY_FILE = "templates/capability.md";
const MAX_CONTEXT_LINES = 1000;
const BOARD_ADVISORY_LINES = 120;
const STYLE_FILE = ".agents/limen/styleguide.md";
const VISION_FILE = "spec/vision.md";
const REGISTER_FILE = ".agents/limen/communication.md";
const PACKAGED_REGISTER = "templates/communication.md";
// A styleguide heading that names one of these words applies only to files with the listed extensions.
const LANGUAGES: Readonly<Record<string, readonly string[]>> = {
	rust: ["rs"],
	typescript: ["ts", "tsx", "mts", "cts"],
	javascript: ["js", "jsx", "mjs", "cjs"],
	frontend: ["ts", "tsx", "js", "jsx", "css", "html", "svelte", "vue"],
	css: ["css", "scss"],
	swift: ["swift"],
	python: ["py"],
};
const jevgrepSeen = new Map<string, boolean>();

type Context = { readonly cwd: string };
type Message = { readonly customType: string; readonly content: string; readonly display: boolean };
type StartEvent = { readonly prompt?: string; readonly systemPrompt?: string };
type StartResult = { readonly message?: Message; readonly systemPrompt?: string };
type ToolContent = { readonly type: string; readonly text?: string };
type ToolEvent = {
	readonly toolName?: string;
	readonly input?: Record<string, unknown>;
	readonly content?: readonly ToolContent[];
	readonly isError?: boolean;
};
type ToolPatch = { readonly content: ToolContent[] };
type PiApi = {
	on(event: "before_agent_start", handler: (event: StartEvent, context: Context) => StartResult | undefined): void;
	on(event: "message_end", handler: (event: unknown) => void): void;
	on(event: "session_start" | "session_compact", handler: () => void): void;
	on(event: "tool_result", handler: (event: ToolEvent, context: Context) => ToolPatch | undefined): void;
};

type ReminderKind = "specs" | "style" | "vision";
type Ask = { readonly kind: ReminderKind; readonly paths: readonly string[] };
type Section = { readonly title: string; readonly level: number; readonly start: number; readonly end: number };
type LineRange = readonly [number, number];
/** What the context holds: guidance lines the agent read, and sections a reminder already named. Compaction drops both. */
type Recall = { readonly read: Map<ReminderKind, LineRange[]>; readonly named: Set<string> };

const REMINDER_KINDS = ["style", "vision", "specs"] as const;
// Each reminder asks for one project file; `pattern` also finds that file, or the packaged register, in a read.
const GUIDANCE: Readonly<Record<ReminderKind, { readonly file: string; readonly pattern: RegExp }>> = {
	style: { file: STYLE_FILE, pattern: /\.agents\/limen\/styleguide\.md\b/ },
	vision: { file: VISION_FILE, pattern: /\bspec\/vision\.md\b/ },
	specs: { file: REGISTER_FILE, pattern: /(?:\.agents\/limen|\btemplates)\/communication\.md\b/ },
};

/**
 * Stable guidance rides the system prompt once per call. The per-turn note is a short cue. After an edit, a spawn or a
 * merge, the tool result asks the agent to read the guidance lines that apply, once per context, until it has read them.
 */
export default function limenCommunication(pi: PiApi): void {
	let lastTouch: string | undefined;
	let lastFailure: string | undefined;
	pi.on("before_agent_start", (event, context) => {
		const root = process.env.LIMEN_CONTEXT_ROOT ?? context.cwd;
		const job = process.env.LIMEN_JOB === "1";
		const touched = lastTouch;
		const failed = lastFailure;
		lastTouch = undefined;
		lastFailure = undefined;
		const extra = guidancePrompt(root, job);
		const message = {
			customType: CONTEXT_TYPE,
			content: turnCue(root, job, isWakePrompt(event.prompt), touched, failed),
			display: false,
		};
		if (!extra) {
			return { message };
		}
		return {
			message,
			systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${extra}` : extra,
		};
	});
	pi.on("message_end", (event) => {
		if (!event || typeof event !== "object" || !("message" in event)) {
			return;
		}
		const message = event.message;
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
			return;
		}
		lastFailure = assistantStopReason(message) || undefined;
	});
	const recall: Recall = { read: new Map(), named: new Set() };
	const forget = () => {
		recall.read.clear();
		recall.named.clear();
	};
	pi.on("session_start", forget);
	pi.on("session_compact", forget);
	pi.on("tool_result", (event, context) => {
		if (event.isError) {
			return;
		}
		noteRead(recall, event);
		const asks = guidanceAsks(event, process.env.LIMEN_JOB === "1");
		if (!asks.length) {
			return;
		}
		lastTouch = touchLine(event, asks);
		const root = process.env.LIMEN_CONTEXT_ROOT ?? context.cwd;
		const reminders = asks.map((ask) => recallReminder(recall, ask, root, context.cwd)).filter(Boolean);
		if (!reminders.length) {
			return;
		}
		return { content: appendText(event.content, reminders.join("\n\n")) };
	});
}

/** What this hook gives a job, for an engine that cannot load it (claude): system-prompt text and the first cue. */
export function jobGuidance(root: string): { readonly system: string; readonly cue: string } {
	return { system: guidancePrompt(root, true), cue: turnCue(root, true, false, undefined, undefined) };
}

function isWakePrompt(prompt: string | undefined): boolean {
	return typeof prompt === "string" && prompt.startsWith("Limen job ");
}

function guidancePrompt(cwd: string, job: boolean): string {
	const parts: string[] = [];
	const frame = capabilitySection("Frame");
	if (frame) {
		parts.push(boundText(frame, `limen/${CAPABILITY_FILE}`, "Capability"));
	}
	if (privatePlanning(cwd, job)) {
		parts.push(privatePlanningGuidance(cwd));
	}
	if (!job) {
		const shop = readInheritedAgents(cwd);
		if (shop) {
			parts.push(shop);
		}
	}
	const register = readRegister(cwd);
	if (register) {
		parts.push(register);
	}
	if (hasJevgrep()) {
		parts.push(registerCue(cwd, "Search"));
	}
	if (!job) {
		const vision = boundFile(cwd, VISION_FILE, "Vision");
		if (vision) {
			parts.push(vision);
		}
	}
	const style = boundFile(cwd, STYLE_FILE, "Styleguide");
	if (style) {
		parts.push(style);
	}
	if (!job) {
		const digest = boardDigest(cwd);
		if (digest) {
			parts.push(digest);
		}
	}
	return parts.join("\n\n");
}

/** `jg` is a common name; only Jevgrep's help mentions Jevgrep. Probed once per PATH. */
function hasJevgrep(): boolean {
	const path = process.env.PATH ?? "";
	const seen = jevgrepSeen.get(path);
	if (seen !== undefined) {
		return seen;
	}
	const help = spawnSync("jg", ["--help"], { encoding: "utf8", timeout: 5000 });
	const found = !help.error && help.status === 0 && /Jevgrep/.test(help.stdout ?? "");
	jevgrepSeen.set(path, found);
	return found;
}

function turnCue(
	cwd: string,
	job: boolean,
	wake: boolean,
	lastTouch: string | undefined,
	failed: string | undefined,
): string {
	const lines = [
		capabilitySection("Cue"),
		registerCue(cwd, "Shared"),
		registerCue(cwd, job ? "Agent" : "Human"),
	].filter(Boolean);
	if (failed) {
		lines.push(registerCue(cwd, "Failure").replaceAll("{{failure}}", failed));
	}
	if (wake) {
		lines.push(registerCue(cwd, "Wake"));
	}
	if (job) {
		const ticket = jobTicket(cwd);
		if (ticket) {
			lines.push(`Ticket: ${ticket}`);
		}
		const prefix = privatePlanning(cwd, job) ? `${cwd}/` : "";
		if (readOptional(join(cwd, VISION_FILE)) !== undefined) {
			lines.push(
				`Vision (read-only): \`${prefix}spec/vision.md\` — durable intent. Load it before choosing or starting work.`,
			);
		}
		if (readOptional(join(cwd, "spec/build.md")) !== undefined) {
			lines.push(`Board (read-only): \`${prefix}spec/build.md\` — consult before reporting work; do not edit.`);
		}
	}
	if (lastTouch) {
		lines.push(lastTouch);
	}
	if (!job) {
		const drift = formatDrift(listDrift(cwd));
		if (drift) {
			lines.push(drift);
		}
		const board = boardAdvisory(cwd);
		if (board) {
			lines.push(board);
		}
	}
	return ["<limen-project-context>", ...lines, "</limen-project-context>"].join("\n\n");
}

/** A job follows the planning source recorded at its spawn; the coordinator follows the project setting. */
function privatePlanning(root: string, job: boolean): boolean {
	const id = process.env.LIMEN_JOB_ID;
	const source = job && id ? recordedPlanningSource(join(root, ".limen/jobs", id)) : planningSource(root);
	return source === "private";
}

function readRegister(cwd: string): string {
	const inherited = inheritFile(cwd, REGISTER_FILE, PACKAGED_REGISTER);
	if (!inherited) {
		return "";
	}
	const cueStart = inherited.text.search(/^## Cue: /m);
	const text = cueStart < 0 ? inherited.text : inherited.text.slice(0, cueStart);
	return boundText(text, inherited.path, "Communication");
}

/** Cue sections belong to the selected register; absent sections have no package fallback. */
function registerCue(cwd: string, heading: string): string {
	const inherited = inheritFile(cwd, REGISTER_FILE, PACKAGED_REGISTER);
	if (!inherited) {
		return "";
	}
	const section = markdownSection(
		trimmedLines(inherited.text).slice(0, MAX_CONTEXT_LINES).join("\n"),
		`Cue: ${heading}`,
	);
	return section.split("\n").slice(1).join("\n").trim();
}

/** The capability frame describes Limen itself, not project speech, so a project register never replaces it. */
function capabilitySection(heading: string): string {
	const text = readOptional(join(packageRoot(), CAPABILITY_FILE)) ?? "";
	return markdownSection(text, heading).split("\n").slice(1).join("\n").trim();
}

function readInheritedAgents(cwd: string): string {
	if (readOptional(join(cwd, "AGENTS.md")) !== undefined) {
		return "";
	}
	const inherited = inheritFile(cwd, "AGENTS.md", "templates/agents.md");
	return inherited ? boundText(inherited.text, inherited.path, "Shop manual") : "";
}

function boundFile(cwd: string, relative: string, label: string): string {
	const text = readOptional(join(cwd, relative));
	return text === undefined ? "" : boundText(text, relative, label);
}

function boundText(text: string, path: string, label: string): string {
	const lines = trimmedLines(text);
	if (!lines.length) {
		return "";
	}
	const content = lines.slice(0, MAX_CONTEXT_LINES).join("\n");
	const notice =
		lines.length > MAX_CONTEXT_LINES
			? `\n\n[${path} truncated to ${MAX_CONTEXT_LINES} of ${lines.length} lines; read the file for remaining context.]`
			: "";
	return `## ${label} (${path})\n${content}${notice}`;
}

function boardAdvisory(cwd: string): string {
	const board = readOptional(join(cwd, "spec/build.md"));
	if (board === undefined) {
		return "";
	}
	const count = trimmedLines(board).length;
	if (count <= BOARD_ADVISORY_LINES) {
		return "";
	}
	return `spec/build.md is ${count} lines; trim TRACK and NEXT, and close landed tickets (limen board lists them).`;
}

function boardDigest(cwd: string): string {
	const board = readOptional(join(cwd, "spec/build.md"));
	if (board === undefined) {
		return "";
	}
	const body = ["NOW", "NEXT"]
		.map((heading) => markdownSection(board, heading))
		.filter(Boolean)
		.join("\n\n");
	return body ? boundText(body, "spec/build.md", "Board digest") : "";
}

function markdownSection(text: string, heading: string): string {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const start = lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, "").trim() === heading);
	if (start < 0) {
		return "";
	}
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index] ?? "")) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trim();
}

function jobTicket(cwd: string): string {
	const id = process.env.LIMEN_JOB_ID?.trim();
	if (!id) {
		return "";
	}
	const task = readOptional(join(cwd, ".limen/jobs", id, "task.md"));
	if (task === undefined) {
		return "";
	}
	return ticketPointers(task)[0]?.path ?? "";
}

/** OMP names the files of a multi-file edit in `paths`; Pi and a one-file OMP edit name the file in `path`. */
function guidanceAsks(event: ToolEvent, job: boolean): readonly Ask[] {
	const name = event.toolName ?? "";
	if (name === "write" || name === "edit") {
		const listed = event.input?.paths;
		const paths = Array.isArray(listed)
			? listed.filter((path): path is string => typeof path === "string")
			: [toolPath(event)];
		const asks: Ask[] = [
			{ kind: "specs", paths: paths.filter(isSpecPath) },
			{ kind: "style", paths: paths.filter((path) => !isSpecPath(path) && isCodePath(path)) },
		];
		return asks.filter((ask) => ask.paths.length);
	}
	if ((name === "bash" || name === "powershell") && isVisionCommand(stringField(event.input, "command"), job)) {
		return [{ kind: "vision", paths: [] }];
	}
	return [];
}

function touchLine(event: ToolEvent, asks: readonly Ask[]): string {
	const paths = asks.flatMap((ask) => ask.paths);
	if (!paths.length) {
		return "Last turn started or merged work.";
	}
	return `Last turn ${event.toolName === "edit" ? "edited" : "wrote"} ${paths.join(", ")}.`;
}

function toolPath(event: ToolEvent): string {
	return stringField(event.input, "path") || stringField(event.input, "file_path");
}

function stringField(input: Record<string, unknown> | undefined, key: string): string {
	const value = input?.[key];
	return typeof value === "string" ? value : "";
}

function posixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function isSpecPath(path: string): boolean {
	return /(?:^|\/)spec\//.test(posixPath(path));
}

function isCodePath(path: string): boolean {
	if (!path || /^[a-z][\w+.-]*:\/\//i.test(path)) {
		return false;
	}
	return !/\.md$/i.test(posixPath(path));
}

/** A worker merges main into its own branch to stay current; that starts no new work. */
function isVisionCommand(command: string, job: boolean): boolean {
	if (/\blimen\s+spawn\b/.test(command)) {
		return true;
	}
	if (/\bgit\s+merge\b/.test(command)) {
		return !job;
	}
	return /\b(?:mkdir|cp|mv|touch|install)\b/.test(command) && /spec\/features\/planned\//.test(command);
}

/** A read tool covers the lines it showed; `cat` covers the whole file, while `head` or `sed` may show only a slice. */
function noteRead(recall: Recall, event: ToolEvent): void {
	const name = event.toolName ?? "";
	if (name === "read") {
		const [, file = "", selector = ""] = /^(.*?\.md)(?::(.*))?$/i.exec(posixPath(toolPath(event))) ?? [];
		const kind = REMINDER_KINDS.find((candidate) => GUIDANCE[candidate].pattern.test(file));
		if (kind) {
			recall.read.set(kind, [...(recall.read.get(kind) ?? []), ...readRanges(selector, event)]);
		}
		return;
	}
	const command = posixPath(stringField(event.input, "command"));
	if ((name !== "bash" && name !== "powershell") || !/\b(?:cat|bat|Get-Content)\b/.test(command)) {
		return;
	}
	for (const kind of REMINDER_KINDS) {
		if (GUIDANCE[kind].pattern.test(command)) {
			recall.read.set(kind, [...(recall.read.get(kind) ?? []), [1, Number.POSITIVE_INFINITY]]);
		}
	}
}

/**
 * A truncated read says `[Showing lines 1-300 of 429`. Otherwise Pi takes offset and limit, and OMP puts `:50-100`,
 * `:50+20`, `:50` or `:5,9` after the path; a read without either shows the whole file.
 */
function readRanges(selector: string, event: ToolEvent): LineRange[] {
	const text = (event.content ?? []).map((part) => part.text ?? "").join("\n");
	const shown = /\[Showing lines (\d+)-(\d+) of \d+/.exec(text);
	if (shown) {
		return [[Number(shown[1]), Number(shown[2])]];
	}
	const offset = event.input?.offset;
	const limit = event.input?.limit;
	if (typeof offset === "number" || typeof limit === "number") {
		const start = typeof offset === "number" ? Math.max(1, offset) : 1;
		return [[start, typeof limit === "number" ? start + limit - 1 : Number.POSITIVE_INFINITY]];
	}
	const parts = selector.split(":").find((part) => /^[\d,+-]+$/.test(part));
	if (!parts) {
		return [[1, Number.POSITIVE_INFINITY]];
	}
	const list = parts.split(",");
	return list.map((part) => lineRange(part, list.length > 1));
}

/** `:-60` counts back from the end of a file this hook does not measure, so it covers nothing. */
function lineRange(part: string, list: boolean): LineRange {
	const [, from = "", sign = "", to = ""] = /^(\d*)([-+]?)(\d*)$/.exec(part) ?? [];
	const start = Number(from);
	if (!start) {
		return [0, 0];
	}
	if (sign === "+" && to) {
		return [start, start + Number(to) - 1];
	}
	if (sign === "-" && to) {
		return [start, Number(to)];
	}
	return [start, list && !sign ? start : Number.POSITIVE_INFINITY];
}

/** Names the guidance lines that apply and are still unread, once until compaction; quiet when nothing new applies. */
function recallReminder(recall: Recall, ask: Ask, root: string, cwd: string): string {
	const guide = guidance(ask.kind, root, cwd);
	const inside = ask.paths.map((path) => projectPath(cwd, path));
	const files = ask.kind === "style" ? inside.filter(Boolean) : ask.paths.map((path, index) => inside[index] || path);
	if (!guide || (ask.kind !== "vision" && !files.length)) {
		return "";
	}
	const read = recall.read.get(ask.kind) ?? [];
	const unread = applicableSections(ask.kind, guide.sections, files).filter((section) => !isRead(section, read));
	const keys = unread.map((section) => `${ask.kind}:${section.start}:${section.title}`);
	if (keys.every((key) => recall.named.has(key))) {
		return "";
	}
	for (const key of keys) {
		recall.named.add(key);
	}
	return reminderText(ask.kind, guide.shown, unread, files);
}

/** The path from the project root, or "" for a file outside it. */
function projectPath(cwd: string, path: string): string {
	const file = posixPath(relative(cwd, resolve(cwd, path)));
	return file.startsWith("../") || isAbsolute(file) ? "" : file;
}

/** The copy in the agent's worktree wins, shown by its short path; the register falls back to the package. */
function guidance(
	kind: ReminderKind,
	root: string,
	cwd: string,
): { readonly shown: string; readonly sections: readonly Section[] } | undefined {
	const paths = [join(cwd, GUIDANCE[kind].file), join(root, GUIDANCE[kind].file)];
	if (kind === "specs") {
		paths.push(join(packageRoot(), PACKAGED_REGISTER));
	}
	for (const path of paths) {
		const text = readOptional(path);
		if (text !== undefined) {
			return { shown: projectPath(cwd, path) || path, sections: markdownSections(text) };
		}
	}
}

function applicableSections(
	kind: ReminderKind,
	sections: readonly Section[],
	files: readonly string[],
): readonly Section[] {
	if (kind === "style") {
		const each = files.map((file) => styleSections(sections, file));
		return sections.filter((section) => each.some((applies) => applies.includes(section)));
	}
	if (kind === "specs") {
		const index = sections.findIndex((section) => section.level === 2 && section.title === "Specs");
		const head = sections[index];
		const next = sections.slice(index + 1).find((section) => section.level <= 2);
		return head ? [{ ...head, end: next ? next.start - 1 : (sections.at(-1)?.end ?? head.end) }] : [];
	}
	return [{ title: "Vision", level: 1, start: 1, end: sections.at(-1)?.end ?? 1 }];
}

/** A heading that names a path or a language scopes its section and the sections below it; others apply to every file. */
function styleSections(sections: readonly Section[], file: string): readonly Section[] {
	const scopes: (boolean | undefined)[] = [];
	return sections.filter((section) => {
		scopes.length = section.level;
		const applies = sectionScope(section.title, file) ?? scopes.findLast((scope) => scope !== undefined);
		scopes[section.level] = applies;
		return applies !== false;
	});
}

/** `crates/alice` matches files below it, `convex/http.ts` itself, and Rust matches `.rs` files. */
function sectionScope(title: string, file: string): boolean | undefined {
	const paths = [...title.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "").filter((token) => /[/.]/.test(token));
	if (paths.length) {
		return paths.some((path) => file === path.replace(/\/$/, "") || file.startsWith(path.replace(/\/?$/, "/")));
	}
	const extension = /\.([^./]+)$/.exec(file)?.[1]?.toLowerCase() ?? "";
	const languages = (title.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => Object.hasOwn(LANGUAGES, word));
	return languages.length ? languages.some((word) => LANGUAGES[word]?.includes(extension)) : undefined;
}

function isRead(section: Section, read: readonly LineRange[]): boolean {
	for (let line = section.start; line <= section.end; line++) {
		if (!read.some(([start, end]) => start <= line && line <= end)) {
			return false;
		}
	}
	return true;
}

function reminderText(
	kind: ReminderKind,
	shown: string,
	sections: readonly Section[],
	files: readonly string[],
): string {
	const ask = `make your next tool call a read of ${shown} lines ${lineList(sections)}`;
	const again = "even if an earlier copy is in your context";
	if (kind === "vision") {
		return `[limen] Vision: ${ask}. Read it ${again}, then check this step against it.`;
	}
	const scoped = sections
		.filter((section) => files.some((file) => sectionScope(section.title, file)))
		.map((section) => section.title);
	const named = scoped.length ? `, including the sections ${scoped.join(", ")}` : "";
	const label = kind === "specs" ? "Specs" : "Styleguide";
	return `[limen] ${label}: ${ask}. They hold the rules for ${files.join(", ")}${named}. Read them ${again}, then check this edit against them.`;
}

/** `1-59, 85-125`: sections that touch share one range. */
function lineList(sections: readonly Section[]): string {
	const ranges: [number, number][] = [];
	for (const { start, end } of sections) {
		const last = ranges.at(-1);
		if (last && last[1] + 1 >= start) {
			last[1] = Math.max(last[1], end);
		} else {
			ranges.push([start, end]);
		}
	}
	return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}

/** Each heading starts a section that runs to the next heading; text above the first heading is a section too. */
function markdownSections(text: string): readonly Section[] {
	const lines = text.replaceAll("\r\n", "\n").trimEnd().split("\n");
	const starts: Omit<Section, "end">[] = [];
	let fenced = false;
	for (const [index, line] of lines.entries()) {
		if (/^\s*(?:```|~~~)/.test(line)) {
			fenced = !fenced;
		}
		const match = fenced ? null : /^(#{1,6})\s+(\S.*?)(?:\s+#+)?\s*$/.exec(line);
		if (match) {
			starts.push({ title: match[2] ?? "", level: match[1]?.length ?? 1, start: index + 1 });
		}
	}
	if (starts[0]?.start !== 1) {
		starts.unshift({ title: "", level: 1, start: 1 });
	}
	return starts.map((section, index) => ({ ...section, end: (starts[index + 1]?.start ?? lines.length + 1) - 1 }));
}

function appendText(content: readonly ToolContent[] | undefined, text: string): ToolContent[] {
	const parts: ToolContent[] = content ? content.map((part) => ({ ...part })) : [];
	const last = parts.at(-1);
	if (last?.type === "text" && typeof last.text === "string") {
		parts[parts.length - 1] = { type: "text", text: `${last.text}\n\n${text}` };
		return parts;
	}
	parts.push({ type: "text", text });
	return parts;
}

function trimmedLines(text: string): readonly string[] {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	while (lines[0]?.trim() === "") {
		lines.shift();
	}
	while (lines.at(-1)?.trim() === "") {
		lines.pop();
	}
	return lines;
}
