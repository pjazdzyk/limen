import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOptional } from "../project/inherit.ts";

// The agent writes the note in its job folder; the project may keep reminders beside its other Limen guidance.
// Limen copies, logs and shows both, and never parses them. Adam approved the wording below as written (F950).
// Limen reads only the "Note check" of the final message, and records its open items in `open-checks`.
const NOTE = "note.md";
const FIRST = "note.first.md";
const TASK = "task.md";
const OPEN = "open-checks";
const REMINDERS = ".agents/limen/reminders.md";
// One "Note check" line: `<check>: <mark>`, then the evidence or the gap. Proven and followed close an item.
const MARKED = /^(.+?):\s*(not proven|proven|changed|dropped|followed|broken)\b[\s.,;:]*(.*)$/i;
const SHOWN = 10;
const FORMAT = [
	"Write a plan, not a task copy or a result log. Use plain technical English. Aim for six lines in three parts:",
	'- Done means: two to four end checks. Each line states what must be true, then "Shown by:" and the command or ' +
		"observation that would prove it.",
	"- Easy to miss: the one task rule that the quickest way to finish could skip or break. Quote it. " +
		'Add "Shown by:" and how to check that it was followed.',
	"- Not proven yet: short names of the end checks and the easy-to-miss rule that lack evidence. Name each one.",
	"Keep exact commands, limits, paths, and counts when they define acceptance. " +
		"Reference a longer acceptance list by its location and item count; do not copy it or omit its checks.",
	"Each check starts unproven. Remove its name from Not proven yet only after you see evidence that it holds. " +
		'Add "Seen: <evidence location>" to that check. Give a pointer, not results. A pointer alone is not proof. ' +
		"The easy-to-miss rule needs its own evidence.",
	'Keep each check in the note after it is proven. Write "Not proven yet: none" only when every check and the rule ' +
		"have evidence. Unknown stays unproven. Do not add context, steps, assumptions, or test totals.",
].join("\n");

/** Added once, to the first prompt of each job, a continued one too. */
export function noteStart(jobDir: string): string {
	const reminders = projectReminders(jobDir);
	return [
		`[limen] Before other work, read ${join(jobDir, NOTE)}, or write it if there is none.`,
		FORMAT,
		"Read an existing note against this task. Keep restrictions that still apply. " +
			"Replace past results with the end checks or limits they reveal. " +
			"Reuse earlier evidence only after you inspect it and confirm that it still applies; " +
			"do not rerun a check just because this is a continued job.",
		...(reminders
			? [
					`Project reminders (${reminders.path}):`,
					reminders.text,
					"Follow each binding reminder. Do not copy them into the note.",
				]
			: []),
	].join("\n");
}

/** Added to each steer message. */
export function noteSteer(jobDir: string): string {
	return [
		"[limen] If this steer changes an end check or the easy-to-miss rule, keep the old line and append " +
			`"Changed: <new requirement>. Reason: <what changed it>" under it in ${join(jobDir, NOTE)}. ` +
			"The new requirement now applies. Put affected checks back in Not proven yet and remove stale Seen pointers. " +
			"Add any new obligation as unproven. Leave an unrelated note unchanged.",
		...(projectReminders(jobDir)
			? [
					"If a reminder changes, record the changed requirement by reference in the note. Do not edit the reminders file.",
				]
			: []),
	].join("\n");
}

/** Sent once, before the finish: the note now, the note at the start, and the project reminders. */
export function noteCheck(jobDir: string, finishTool: boolean): string {
	const now = readOptional(join(jobDir, NOTE))?.trim();
	const first = readOptional(join(jobDir, FIRST))?.trim();
	const reminders = projectReminders(jobDir);
	return [
		...(now
			? ["[limen] Your note now:", now]
			: [
					`[limen] No note exists in ${join(jobDir, NOTE)}. Read ${join(jobDir, TASK)} and reconstruct the end checks ` +
						"and the easy-to-miss rule. Do not assume they are proven.",
				]),
		...(now && first && first !== now ? ["Your note at the start:", first] : []),
		...(reminders ? ["Project reminders:", reminders.text] : []),
		"Compare the note with the task and later instructions. Keep the final message short: what changed, " +
			"where the evidence is, and what is still open. " +
			'Under the heading "Note check", give one line for each item that is still open: ' +
			'"- <check>: <mark>. <the gap>". The mark is not proven, changed, dropped, or broken. ' +
			"Do not list what holds: the coordinator reads the evidence. " +
			'When nothing is open, write "- all checks: proven." ' +
			"Limen sends each open line to the coordinator, and the job ends as done with open checks.",
		"Do not repeat a run-once check or run a forbidden check to clear the note. " +
			"Report any remaining gap without claiming completion.",
		...(finishTool ? ['Then call finish again. Its handoff is that whole final message, with the "Note check".'] : []),
	].join("\n");
}

/** Keeps the first version of the note as `note.first.md` and logs each change. Returns the text it saw last. */
export function recordNote(jobDir: string, seen: string | undefined): string | undefined {
	const now = readOptional(join(jobDir, NOTE));
	if (now === undefined || now === seen) {
		return seen;
	}
	if (!existsSync(join(jobDir, FIRST))) {
		writeFileSync(join(jobDir, FIRST), now);
	}
	appendFileSync(join(jobDir, "log"), `[limen ${new Date().toISOString()}] note changed\n`);
	return now;
}

/**
 * The open items of the final "Note check", for `open-checks`: each line marked not proven, changed, dropped, or
 * broken, and each proven line whose evidence Limen cannot find. The note and the reminders share these lines.
 * A check that was sent and not answered is one item.
 */
export function noteCheckOpen(jobDir: string): string[] {
	const lines = noteCheckSection(readOptional(join(jobDir, "result")) ?? "");
	if (!lines) {
		const sent = (readOptional(join(jobDir, "log")) ?? "").includes("] note check sent\n");
		return sent ? ["Note check: missing from the final message"] : [];
	}
	const items = markedItems(lines);
	if (!items.length) {
		return ['Note check: no line reads "<check>: <mark>"'];
	}
	return items.flatMap(openItem).map((line) => clip(line, 240));
}

/** The open items a done job recorded, as wake lines: at most ten, then a count of the rest. */
export function openChecks(jobDir: string): string[] {
	const open = (readOptional(join(jobDir, OPEN)) ?? "").split("\n").filter(Boolean);
	const more = open.length > SHOWN ? [`… ${open.length - SHOWN} more in ${join(jobDir, OPEN)}`] : [];
	return [...open.slice(0, SHOWN).map((line) => `- ${line}`), ...more];
}

type Marked = { readonly name: string; readonly mark: string; readonly said: string; evidence: string };

/** The lines under the first "Note check" heading, up to the next Markdown heading; undefined without one. */
function noteCheckSection(result: string): string[] | undefined {
	const lines = result.split("\n");
	const start = lines.findIndex((line) => /^\s*(?:#{1,6}\s+)?[*_]*note check\b.{0,40}$/i.test(line));
	if (start === -1) {
		return;
	}
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
	return end === -1 ? rest : rest.slice(0, end);
}

/** Each `<check>: <mark>` line, with the indented lines right under it as more evidence. */
function markedItems(lines: readonly string[]): Marked[] {
	const items: Marked[] = [];
	let current: Marked | undefined;
	for (const line of lines) {
		const bare = line
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
			.replace(/\*\*|__/g, "")
			.trim();
		const match = MARKED.exec(bare);
		if (match) {
			const said = (match[3] ?? "").trim();
			current = { name: (match[1] ?? "").trim(), mark: (match[2] ?? "").toLowerCase(), said, evidence: said };
			items.push(current);
		} else if (current && /^\s+\S/.test(line)) {
			current.evidence += `\n${line}`;
		} else {
			current = undefined;
		}
	}
	return items;
}

/** Open is whatever is not marked proven or followed. Whether a proven line holds is the coordinator's reading. */
function openItem(item: Marked): string[] {
	if (item.mark === "followed" || item.mark === "proven") {
		return [];
	}
	return [`${item.name}: ${item.mark}${item.said ? `. ${item.said}` : ""}`];
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A job folder is `<root>/.limen/jobs/<id>`; the reminders belong to that root. Absent or empty means none. */
function projectReminders(jobDir: string): { readonly path: string; readonly text: string } | undefined {
	const path = join(resolve(jobDir, "..", "..", ".."), REMINDERS);
	const text = readOptional(path)?.trim();
	return text ? { path, text } : undefined;
}
