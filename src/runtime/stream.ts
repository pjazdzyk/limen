import type { EngineId } from "./engine.ts";

export type Activity = "think" | "tool" | "wait";
export type StreamEvent =
	| { readonly kind: "log"; readonly line: string }
	// `settled`: claude's `result` event, the end of a turn; its text repeats the last reply.
	| { readonly kind: "assistant"; readonly text: string; readonly stopReason?: string; readonly settled?: true }
	| { readonly kind: "tool"; readonly name: string; readonly detail?: string }
	| { readonly kind: "activity"; readonly name: Activity };
/** Pi and OMP share one JSON event stream; claude's stream-json is read into the same events. */
export function createStreamParser(engine: EngineId = "pi"): {
	push(chunk: string): StreamEvent[];
	flush(): StreamEvent[];
} {
	let buffer = "";
	const read = engine === "claude" ? claudeReader() : (event: unknown) => compact([interpret(event)]);
	const take = (line: string): StreamEvent[] => {
		const trimmed = line.trim();
		if (!trimmed) {
			return [];
		}
		if (!trimmed.startsWith("{")) {
			return [{ kind: "log", line: trimmed }];
		}
		try {
			return read(JSON.parse(trimmed));
		} catch {
			return [{ kind: "log", line: trimmed }];
		}
	};
	return {
		push(chunk) {
			buffer += chunk;
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			return lines.flatMap(take);
		},
		flush() {
			const events = take(buffer);
			buffer = "";
			return events;
		},
	};
}
type ClaudePart = {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly name?: unknown;
	readonly input?: unknown;
};
/**
 * Claude Code's stream-json: `system/init` starts, `assistant` carries text, thinking and `tool_use` parts, a `user`
 * message with `tool_result` ends a tool, and `result` ends the turn. Subagent text (parent_tool_use_id) is no reply.
 */
function claudeReader(): (event: unknown) => StreamEvent[] {
	let last = "";
	return (event) => {
		if (!event || typeof event !== "object") {
			return [];
		}
		const row = event as Record<string, unknown>;
		const message = row.message as { content?: unknown } | undefined;
		const parts: ClaudePart[] = Array.isArray(message?.content) ? message.content : [];
		if (row.type === "system") {
			return row.subtype === "init" ? [{ kind: "activity", name: "think" }] : [];
		}
		if (row.type === "user") {
			return parts.some((part) => part?.type === "tool_result") ? [{ kind: "activity", name: "wait" }] : [];
		}
		if (row.type === "assistant") {
			return parts.flatMap((part) =>
				claudePart(part, typeof row.parent_tool_use_id === "string", (text) => (last = text)),
			);
		}
		return row.type === "result" ? [claudeResult(row, last)] : [];
	};
}
/** The end of a turn. An error result fails the job with its text; a success repeats the last reply. */
function claudeResult(row: Record<string, unknown>, last: string): StreamEvent {
	const text = typeof row.result === "string" ? row.result.trim() : "";
	const subtype = typeof row.subtype === "string" ? row.subtype : "";
	if (row.is_error !== true && !subtype.startsWith("error")) {
		return { kind: "assistant", text: text || last, settled: true };
	}
	const detail = (text || subtype).replace(/\s+/g, " ").trim();
	return { kind: "assistant", text: last, settled: true, stopReason: detail ? `error: ${detail}` : "error" };
}
function claudePart(part: ClaudePart, nested: boolean, reply: (text: string) => void): StreamEvent[] {
	if (part?.type === "tool_use" && typeof part.name === "string" && part.name.trim()) {
		const detail = toolDetail(part.input);
		return [{ kind: "tool", name: part.name.trim(), ...(detail ? { detail } : {}) }];
	}
	if (part?.type === "text" && !nested && typeof part.text === "string" && part.text.trim()) {
		reply(part.text.trim());
		return [{ kind: "assistant", text: part.text.trim() }];
	}
	return part?.type === "thinking" ? [{ kind: "activity", name: "think" }] : [];
}
function interpret(event: unknown): StreamEvent | undefined {
	if (!event || typeof event !== "object" || !("type" in event)) {
		return;
	}
	const tool = "toolName" in event && typeof event.toolName === "string" ? event.toolName.trim() : "";
	if (event.type === "tool_execution_start" && tool) {
		const detail = "args" in event ? toolDetail(event.args) : "";
		return { kind: "tool", name: tool, ...(detail ? { detail } : {}) };
	}
	if (event.type === "tool_execution_end") {
		return { kind: "activity", name: "wait" };
	}
	if (event.type === "message_end") {
		const message = "message" in event ? event.message : undefined;
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
			return { kind: "activity", name: "think" };
		}
		const text = assistantText(message),
			stopReason = assistantStopReason(message);
		return { kind: "assistant", text, ...(stopReason ? { stopReason } : {}) };
	}
	if (
		event.type === "agent_start" ||
		event.type === "turn_start" ||
		event.type === "message_start" ||
		event.type === "message_update"
	) {
		return { kind: "activity", name: "think" };
	}
}
export function assistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
		return "";
	}
	if (!("content" in message) || !Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.flatMap((part) =>
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("")
		.trim();
}
export function assistantStopReason(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
		return "";
	}
	const reason =
		"stopReason" in message && (message.stopReason === "error" || message.stopReason === "aborted")
			? message.stopReason
			: "";
	const detail =
		reason && "errorMessage" in message && typeof message.errorMessage === "string"
			? message.errorMessage.replace(/\s+/g, " ").trim()
			: "";
	return detail ? `${reason}: ${detail}` : reason;
}
function toolDetail(args: unknown): string {
	if (!args || typeof args !== "object") {
		return "";
	}
	for (const key of ["command", "path", "file_path"]) {
		const value = (args as Record<string, unknown>)[key];
		if (typeof value === "string") {
			return value.trim().replace(/\s+/g, " ").slice(0, 80);
		}
	}
	return "";
}
function compact(events: Array<StreamEvent | undefined>): StreamEvent[] {
	return events.filter((event): event is StreamEvent => event !== undefined);
}
