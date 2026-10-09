// A hosted tab keeps /usr/bin reachable for git, but never in front of the caller's own tools: a Linux system Node in
// /usr/bin would otherwise run the engine and fail to load the TypeScript hooks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withUsrBin } from "../src/commands/spawn.ts";

test("hosted PATH keeps the caller's order and appends /usr/bin only when it is missing", () => {
	assert.equal(withUsrBin("/opt/node24/bin:/usr/bin:/bin"), "/opt/node24/bin:/usr/bin:/bin");
	assert.equal(withUsrBin("/opt/node24/bin:/bin"), "/opt/node24/bin:/bin:/usr/bin");
	assert.equal(withUsrBin(undefined), "/usr/bin");
	assert.equal(withUsrBin(""), "/usr/bin");
});
