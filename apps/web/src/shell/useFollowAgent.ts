import { useEffect } from "react";
import { followFileAtLine, userNavigationEpoch } from "../panels/openTabs";
import { selectFollowActive, useAppStore } from "../store";
import { getTransport } from "../transport";
import {
	changedLine,
	createFollowQueue,
	type FileMutation,
	followTargetGroupId,
	newFileMutations,
} from "./followAgent";
import { collectCenterGroups } from "./layout";

/** True when `tabId` sits in the group that shows the chat: selecting it there would hide the conversation. */
function fileSharesChatGroup(workspaceId: string, tabId: string, chatTabId: string): boolean {
	const document = useAppStore.getState().layoutDocumentsByWorkspace[workspaceId];
	const groups = document ? collectCenterGroups(document.center) : [];
	return groups.some(
		(group) =>
			group.tabs.some((tab) => tab.id === tabId) && group.tabs.some((tab) => tab.id === chatTabId),
	);
}

async function follow(
	workspaceId: string,
	chatTabId: string,
	mutation: FileMutation,
	isStale: () => boolean,
): Promise<void> {
	try {
		const { content } = await getTransport().request("fs.readFile", {
			workspaceId,
			path: mutation.path,
		});
		const state = useAppStore.getState();
		if (state.activeWorkspaceId !== workspaceId || !selectFollowActive(state, workspaceId)) return;
		if (isStale()) return;
		const document = state.layoutDocumentsByWorkspace[workspaceId];
		const groups = document ? collectCenterGroups(document.center) : [];
		await followFileAtLine(
			workspaceId,
			mutation.path,
			changedLine(content, mutation),
			followTargetGroupId(groups, chatTabId),
			(tabId) => !fileSharesChatGroup(workspaceId, tabId, chatTabId),
			() => {
				const current = useAppStore.getState();
				return (
					current.activeWorkspaceId === workspaceId &&
					selectFollowActive(current, workspaceId) &&
					!isStale()
				);
			},
		);
	} catch {
		// The file may be gone again by the time we read it; there is nothing to follow.
	}
}

/**
 * Follow Agent ([[submodule-web-shell]], *Follow Agent*): shows the files the active workspace's agent
 * creates or edits, as they settle. Mounted once by the shell.
 */
export function useFollowAgent(): void {
	useEffect(() => {
		const seen = new Set<string>();
		const primed = new Set<string>();
		// Reads finish in any order; chaining them keeps the editor on the newest mutation.
		const enqueue = createFollowQueue(userNavigationEpoch);
		const scan = (
			state: ReturnType<typeof useAppStore.getState>,
			previous: typeof state | null,
		) => {
			const workspaceId = state.activeWorkspaceId;
			if (!workspaceId) return;
			for (const tab of state.tabsByWorkspace[workspaceId] ?? []) {
				if (tab.kind !== "chat") continue;
				const runtime = state.sessions[tab.sessionId];
				if (!runtime) continue;
				const fresh = newFileMutations(runtime.turns, runtime.toolResults, seen);
				if (!primed.has(tab.sessionId)) {
					primed.add(tab.sessionId);
					for (const mutation of fresh) seen.add(mutation.toolCallId);
					continue;
				}
				if (previous && runtime.toolResults === previous.sessions[tab.sessionId]?.toolResults) {
					continue;
				}
				// One event batch can carry a settled edit and the turn's own agent_settled: the run that
				// just ended in this update still counts as streaming for the mutations it completed.
				const wasStreaming = previous?.sessions[tab.sessionId]?.isStreaming === true;
				const following =
					(runtime.isStreaming || wasStreaming) && selectFollowActive(state, workspaceId);
				for (const mutation of fresh) {
					seen.add(mutation.toolCallId);
					if (following) {
						enqueue(workspaceId, (isStale) => follow(workspaceId, tab.id, mutation, isStale));
					}
				}
			}
		};
		scan(useAppStore.getState(), null);
		return useAppStore.subscribe(scan);
	}, []);
}
