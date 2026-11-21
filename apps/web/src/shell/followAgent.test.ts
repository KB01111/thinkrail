import { describe, expect, it } from "bun:test";
import type { ChatTurn, ToolResultState } from "../chat/types";
import {
	changedLine,
	createFollowQueue,
	followTargetGroupId,
	newFileMutations,
} from "./followAgent";
import type { LayoutCenterGroup } from "./layout";

function assistant(id: string, calls: Array<{ id: string; name: string; args: object }>): ChatTurn {
	return {
		kind: "assistant",
		id,
		streaming: false,
		message: {
			role: "assistant",
			content: calls.map((call) => ({
				type: "toolCall" as const,
				id: call.id,
				name: call.name,
				arguments: call.args,
			})),
			timestamp: 0,
		},
	} as unknown as ChatTurn;
}

const done: ToolResultState = { status: "done", raw: null };
const running: ToolResultState = { status: "running", raw: null };

describe("newFileMutations", () => {
	const turns = [
		assistant("a1", [
			{ id: "t1", name: "edit", args: { path: "src/a.ts", oldText: "x", newText: "y" } },
			{ id: "t2", name: "write", args: { path: "b.md", content: "hi" } },
			{ id: "t3", name: "read", args: { path: "c.ts" } },
			{ id: "t4", name: "edit", args: { path: "d.ts", new_string: "z" } },
			{ id: "t5", name: "edit", args: { oldText: "x", newText: "y" } },
		]),
	];

	it("returns settled edits and writes only, with their path and new text", () => {
		const found = newFileMutations(
			turns,
			{ t1: done, t2: done, t3: done, t4: running, t5: done },
			new Set(),
		);
		expect(found).toEqual([
			{ toolCallId: "t1", kind: "edit", path: "src/a.ts", newText: "y" },
			{ toolCallId: "t2", kind: "write", path: "b.md", newText: "" },
		]);
	});

	it("skips what was seen and reads the alternative new-text argument names", () => {
		const found = newFileMutations(turns, { t1: done, t4: done }, new Set(["t1"]));
		expect(found).toEqual([{ toolCallId: "t4", kind: "edit", path: "d.ts", newText: "z" }]);
	});

	it("ignores user and system turns", () => {
		const system: ChatTurn = { kind: "system", id: "s", text: "x" };
		expect(newFileMutations([system], { t1: done }, new Set())).toEqual([]);
	});
});

describe("changedLine", () => {
	const content = "one\ntwo\nthree\nfour\n";

	it("is the line the new text starts on", () => {
		expect(changedLine(content, { kind: "edit", newText: "three\nfour" })).toBe(3);
		expect(changedLine(content, { kind: "edit", newText: "\n\n  two" })).toBe(2);
	});

	it("falls back to line 1 for a write, an empty edit or text that is not found", () => {
		expect(changedLine(content, { kind: "write", newText: "" })).toBe(1);
		expect(changedLine(content, { kind: "edit", newText: "" })).toBe(1);
		expect(changedLine(content, { kind: "edit", newText: "missing" })).toBe(1);
	});

	it("never picks an unrelated twin when the text matches more than once", () => {
		const twins = "return 2;\nx\nreturn 2;\n";
		expect(changedLine(twins, { kind: "edit", newText: "return 2;" })).toBe(1);
	});

	it("prefers the location the host reported, even for repeated text", () => {
		const twins = "return 2;\nx\nreturn 2;\n";
		expect(changedLine(twins, { kind: "edit", newText: "return 2;", firstChangedLine: 3 })).toBe(3);
	});
});

describe("followTargetGroupId", () => {
	const chat = { kind: "chat", id: "chat-1" };
	const file = { kind: "file", id: "file-1" };
	const group = (id: string, tabs: object[]) => ({ kind: "group", id, tabs }) as LayoutCenterGroup;

	it("prefers another group already showing a file, then any other group", () => {
		expect(
			followTargetGroupId([group("g1", [chat]), group("g2", []), group("g3", [file])], "chat-1"),
		).toBe("g3");
		expect(followTargetGroupId([group("g1", [chat]), group("g2", [])], "chat-1")).toBe("g2");
	});

	it("leaves the choice to the layout when the chat has the only group", () => {
		expect(followTargetGroupId([group("g1", [chat, file])], "chat-1")).toBeUndefined();
	});
});

describe("createFollowQueue", () => {
	it("cancels every follow queued before a navigation, including one waiting behind a held read", async () => {
		const epochs = new Map<string, number>();
		const epoch = (workspaceId: string) => epochs.get(workspaceId) ?? 0;
		const enqueue = createFollowQueue(epoch);
		const outcomes: string[] = [];
		let releaseRead = () => {};
		const heldRead = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});

		enqueue("ws", async (isStale) => {
			await heldRead;
			outcomes.push(isStale() ? "first:stale" : "first:fresh");
		});
		enqueue("ws", async (isStale) => {
			outcomes.push(isStale() ? "second:stale" : "second:fresh");
		});
		epochs.set("ws", 1);
		enqueue("ws", async (isStale) => {
			outcomes.push(isStale() ? "third:stale" : "third:fresh");
		});
		releaseRead();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(outcomes).toEqual(["first:stale", "second:stale", "third:fresh"]);
	});

	it("keeps another workspace's navigation out of a follow", async () => {
		const epochs = new Map<string, number>();
		const enqueue = createFollowQueue((workspaceId) => epochs.get(workspaceId) ?? 0);
		const seen: boolean[] = [];
		enqueue("a", async (isStale) => {
			epochs.set("b", 5);
			seen.push(isStale());
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual([false]);
	});
});
