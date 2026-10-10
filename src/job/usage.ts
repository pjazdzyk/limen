import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What a job's own assistant turns recorded: the routes that answered and their token totals. */
export type SessionUsage = {
	readonly served: readonly string[];
	readonly turns: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
};

const COUNTED = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * Sums the assistant messages in the job's session transcripts written at or after `since`, so a continuation does
 * not count the parent turns it copied. Undefined until the job has an assistant turn.
 */
export function readSessionUsage(jobDir: string, since: number): SessionUsage | undefined {
	const session = join(jobDir, "session");
	let files: string[];
	try {
		files = readdirSync(session).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	const served = new Set<string>();
	const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const file of files) {
		const lines = readFileSync(join(session, file), "utf8").split("\n");
		for (const turn of [...lines.map((line) => assistantTurn(line, since)), ...claudeTurns(lines, since)]) {
			if (!turn) {
				continue;
			}
			totals.turns += 1;
			served.add(turn.provider ? `${turn.provider}/${turn.model}` : turn.model);
			for (const key of COUNTED) {
				totals[key] += turn.usage[key];
			}
		}
	}
	return totals.turns ? { served: [...served], ...totals } : undefined;
}

/**
 * The served route, with the requested model beside it when a turn ran another one. A bare requested id matches any
 * provider prefix. This informs; it never blocks.
 */
export function modelLine(requested: string, usage: SessionUsage | undefined): string {
	if (!usage) {
		return requested ? `requested ${requested}; no turn yet` : "";
	}
	const served = usage.served.join(" + ");
	// A Claude Code alias (`haiku`) matches the model it resolves to (`anthropic/claude-haiku-5-5`).
	const asked = (route: string) =>
		route === requested || route.endsWith(`/${requested}`) || route.includes(`/claude-${requested}-`);
	if (!requested || usage.served.every(asked)) {
		return served;
	}
	return `served ${served} · requested ${requested}`;
}

export function tokenLine(usage: SessionUsage): string {
	const count = (value: number) => value.toLocaleString("en-US");
	return [
		`${usage.turns} turns`,
		`input ${count(usage.input)}`,
		`output ${count(usage.output)}`,
		`cache read ${count(usage.cacheRead)}`,
		`cache write ${count(usage.cacheWrite)}`,
	].join(" · ");
}

type Turn = { provider: string; model: string; usage: Record<(typeof COUNTED)[number], number> };

function assistantTurn(line: string, since: number): Turn | undefined {
	if (!line.includes('"assistant"')) {
		return undefined;
	}
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	const { type, timestamp, message } = (entry ?? {}) as { type?: unknown; timestamp?: unknown; message?: unknown };
	const { role, provider, model, usage } = (message ?? {}) as Record<string, unknown>;
	if (type !== "message" || role !== "assistant" || typeof model !== "string") {
		return undefined;
	}
	if (typeof timestamp === "string" && Date.parse(timestamp) < since) {
		return undefined;
	}
	const counts = (usage ?? {}) as Record<string, unknown>;
	const number = (key: string) => (typeof counts[key] === "number" ? (counts[key] as number) : 0);
	return {
		provider: typeof provider === "string" ? provider : "",
		model,
		usage: {
			input: number("input"),
			output: number("output"),
			cacheRead: number("cacheRead"),
			cacheWrite: number("cacheWrite"),
		},
	};
}

/**
 * The turns of a `claude` job's Claude Code stream-json transcript. Each content block repeats its message's usage
 * with a partial output count; the `result` that ends a turn carries the turn's exact usage, so it goes on the
 * turn's last message. Messages after the last result (a cut turn) keep their streamed usage.
 */
function claudeTurns(lines: readonly string[], since: number): Turn[] {
	const turns: Turn[] = [];
	let open = new Map<string, Turn>();
	for (const line of lines) {
		const event = claudeEvent(line);
		const message = (event?.message ?? {}) as { id?: unknown; model?: unknown; usage?: unknown };
		const own = typeof event?.timestamp !== "string" || Date.parse(event.timestamp) >= since;
		if (event?.type === "assistant" && own && typeof message.id === "string" && typeof message.model === "string") {
			if (message.model !== "<synthetic>") {
				open.set(message.id, { provider: "anthropic", model: message.model, usage: claudeCounts(message.usage) });
			}
		} else if (event?.type === "result" && open.size) {
			const ended = [...open.values()].map((turn) => ({ ...turn, usage: claudeCounts(undefined) }));
			ended.splice(-1, 1, { ...(ended.at(-1) as Turn), usage: claudeCounts(event.usage) });
			turns.push(...ended);
			open = new Map();
		}
	}
	return [...turns, ...open.values()];
}

function claudeEvent(
	line: string,
): { type?: unknown; timestamp?: unknown; message?: unknown; usage?: unknown } | undefined {
	if (!(line.includes('"type":"assistant"') || line.includes('"type":"result"'))) {
		return undefined;
	}
	try {
		return JSON.parse(line) ?? undefined;
	} catch {
		return undefined;
	}
}

function claudeCounts(usage: unknown): Turn["usage"] {
	const counts = (usage ?? {}) as Record<string, unknown>;
	const number = (key: string) => (typeof counts[key] === "number" ? (counts[key] as number) : 0);
	return {
		input: number("input_tokens"),
		output: number("output_tokens"),
		cacheRead: number("cache_read_input_tokens"),
		cacheWrite: number("cache_creation_input_tokens"),
	};
}
