import type { GitDiffScope } from "@thinkrail/contracts";
import { SOURCE_RENDERER_ID } from "@thinkrail/resource-renderers";
import {
	DOUBLE_CLICK_SETTLE_MS,
	fileName,
	layoutResourceIdentity,
	projectRelativePath,
	tupleKey,
} from "../lib";
import {
	type CenterNavigationStamp,
	type ChangesTab,
	createChangesTab,
	type EditorTab,
	type FileComparisonTab,
	isCenterNavigationCurrent,
	type LayoutOpenOptions,
	layoutOpenOptionsForNavigation,
	selectDiffTabTargetRef,
	selectWorkspaceById,
	selectWorkspaceNavTick,
	selectWorkspaceTick,
	type TabIntent,
	useAppStore,
} from "../store";
import { getTransport } from "../transport";
import { changesTabId, diffTabId } from "./changesModel";

function baseName(path: string): string {
	return path.split("/").pop() || path;
}

/** Where a read tab opens when the caller, not the focus clock, decides: `activate: false` keeps focus put. */
export type OpenTabPlacement = Pick<LayoutOpenOptions, "activate" | "targetGroupId">;

interface ReadFlight {
	intent: TabIntent;
	placement: OpenTabPlacement;
	/** A passive caller's veto, checked once the read lands: true drops the open instead of installing it. */
	stale: (() => boolean) | undefined;
	claimPreview: boolean;
	navigation: CenterNavigationStamp | null;
	requestedAt: number;
	done: Promise<void>;
}

const inFlight = new Map<string, ReadFlight>();

function navTick(workspaceId: string): number {
	return selectWorkspaceNavTick(useAppStore.getState(), workspaceId);
}

async function openReadTab<T>(
	workspaceId: string,
	id: string,
	resourceIdentity: string,
	intent: TabIntent,
	read: () => Promise<T>,
	build: (payload: T, loadedTick: number) => EditorTab,
	requestedNavigation?: CenterNavigationStamp | null,
	claimPreview = false,
	placement: OpenTabPlacement = {},
	stale?: () => boolean,
): Promise<void> {
	const navigation =
		requestedNavigation === undefined
			? useAppStore.getState().beginCenterNavigation(workspaceId)
			: requestedNavigation;
	const store = useAppStore.getState();
	if (store.removedWorkspaceIds[workspaceId]) return;
	if (intent === "preview" && !isCenterNavigationCurrent(store, workspaceId, navigation)) return;
	const pending = inFlight.get(id);
	if (pending) {
		if (intent === "preview" || claimPreview) pending.claimPreview = true;
		if (intent === "keep") pending.intent = "keep";
		// A passive request (Follow Agent) joins a pending foreground open without taking it over: the user's
		// activation and navigation stamp stay. A foreground request still supersedes a passive one.
		const passiveJoiningForeground =
			placement.activate === false && pending.placement.activate !== false;
		if (!passiveJoiningForeground) {
			pending.placement = placement;
			pending.stale = stale;
			pending.navigation = navigation;
			pending.requestedAt = navTick(workspaceId);
		}
		return pending.done;
	}
	const cached = (store.tabsByWorkspace[workspaceId] ?? []).find(
		(tab) =>
			(tab.kind === "file" || tab.kind === "diff") &&
			layoutResourceIdentity(tab) === resourceIdentity,
	);
	if (cached) {
		const claim =
			intent === "keep" &&
			claimPreview &&
			(!navigation || isCenterNavigationCurrent(store, workspaceId, navigation));
		const options = {
			...layoutOpenOptionsForNavigation(store, workspaceId, navigation),
			...placement,
		};
		store.openTab(cached, intent, true, claim ? { ...options, claimPreview: true } : options);
		return;
	}
	const loadedTick = selectWorkspaceTick(useAppStore.getState(), workspaceId);
	const flight: ReadFlight = {
		intent,
		placement,
		stale,
		claimPreview: intent === "preview" || claimPreview,
		navigation,
		requestedAt: navTick(workspaceId),
		done: Promise.resolve(),
	};
	inFlight.set(id, flight);
	flight.done = installRead(workspaceId, id, resourceIdentity, flight, loadedTick, read, build);
	return flight.done;
}

async function installRead<T>(
	workspaceId: string,
	id: string,
	resourceIdentity: string,
	flight: ReadFlight,
	loadedTick: number,
	read: () => Promise<T>,
	build: (payload: T, loadedTick: number) => EditorTab,
): Promise<void> {
	try {
		const payload = await read();
		if (flight.stale?.()) return;
		const currentState = useAppStore.getState();
		const overtaken = flight.navigation
			? !isCenterNavigationCurrent(currentState, workspaceId, flight.navigation)
			: navTick(workspaceId) !== flight.requestedAt;
		if (flight.intent === "preview" && overtaken) return;
		const installedCache = (currentState.tabsByWorkspace[workspaceId] ?? []).find(
			(tab) =>
				(tab.kind === "file" || tab.kind === "diff") &&
				layoutResourceIdentity(tab) === resourceIdentity,
		);
		const tab = installedCache ?? build(payload, loadedTick);
		const options = {
			...layoutOpenOptionsForNavigation(currentState, workspaceId, flight.navigation),
			...flight.placement,
		};
		useAppStore
			.getState()
			.openTab(
				tab,
				flight.intent,
				true,
				flight.intent === "keep" && flight.claimPreview && !overtaken
					? { ...options, claimPreview: true }
					: options,
			);
	} catch {
	} finally {
		inFlight.delete(id);
	}
}

export function openFileInTab(
	workspaceId: string,
	reported: string,
	intent: TabIntent,
	requestedNavigation?: CenterNavigationStamp | null,
	placement: OpenTabPlacement = {},
	stale?: () => boolean,
): Promise<void> {
	const path = projectRelativePath(
		reported,
		selectWorkspaceById(useAppStore.getState(), workspaceId)?.worktreePath,
	);
	const id = tupleKey("file", workspaceId, path);
	return openReadTab(
		workspaceId,
		id,
		layoutResourceIdentity({ kind: "file", id, name: baseName(path), path }),
		intent,
		() => getTransport().request("fs.readFile", { workspaceId, path }),
		({ content, meta }, loadedTick) => ({
			kind: "file",
			id,
			workspaceId,
			path,
			name: baseName(path),
			content,
			meta,
			loadedTick,
		}),
		requestedNavigation,
		false,
		placement,
		stale,
	);
}

export async function openFileAtLine(
	workspaceId: string,
	path: string,
	at: { line: number; column?: number; length?: number; flash?: boolean },
	intent: TabIntent,
	placement?: OpenTabPlacement,
): Promise<void> {
	await (placement
		? openFileInTab(workspaceId, path, intent, null, placement)
		: openFileInTab(workspaceId, path, intent));
	useAppStore.getState().revealFileTab(workspaceId, path, at, SOURCE_RENDERER_ID);
}

export function openDiffInTab(
	workspaceId: string,
	scope: GitDiffScope,
	path: string,
	intent: TabIntent,
	requestedNavigation?: CenterNavigationStamp | null,
	options: { claimPreview?: boolean } = {},
): Promise<void> {
	const canonicalPath = projectRelativePath(
		path,
		selectWorkspaceById(useAppStore.getState(), workspaceId)?.worktreePath,
	);
	const id = diffTabId(workspaceId, scope, canonicalPath);
	const target = selectDiffTabTargetRef(useAppStore.getState(), { workspaceId, scope });
	return openReadTab(
		workspaceId,
		id,
		layoutResourceIdentity({
			kind: "diff",
			id,
			name: fileName(canonicalPath),
			path: canonicalPath,
			scope,
		}),
		intent,
		() => getTransport().request("git.diffFile", { workspaceId, path: canonicalPath, scope }),
		({ original, modified, meta, originalOid }, loadedTick) => ({
			kind: "diff",
			id,
			workspaceId,
			path: canonicalPath,
			scope,
			name: fileName(canonicalPath),
			original,
			modified,
			meta,
			originalOid,
			loadedTick,
			loadedTarget: target,
		}),
		requestedNavigation,
		options.claimPreview,
	);
}

export function fileComparisonTab(
	workspaceId: string,
	before: string,
	path: string,
): FileComparisonTab {
	return {
		kind: "diff",
		id: tupleKey("compare", workspaceId, before, path),
		workspaceId,
		name: `${baseName(before)} → ${baseName(path)}`,
		path,
		before,
	};
}

export function openFileComparisonInTab(
	workspaceId: string,
	before: string,
	path: string,
	intent: TabIntent,
): Promise<void> {
	const worktree = selectWorkspaceById(useAppStore.getState(), workspaceId)?.worktreePath;
	const tab = fileComparisonTab(
		workspaceId,
		projectRelativePath(before, worktree),
		projectRelativePath(path, worktree),
	);
	return openReadTab(
		workspaceId,
		tab.id,
		layoutResourceIdentity(tab),
		intent,
		() => Promise.resolve(null),
		(_payload, loadedTick) => ({ ...tab, loadedTick }),
	);
}

export async function openChangesTab(
	workspaceId: string,
	scope: GitDiffScope,
	options: { revealPath?: string | null } = {},
	intent: TabIntent = "preview",
	requestedNavigation?: CenterNavigationStamp | null,
): Promise<void> {
	const navigation =
		requestedNavigation === undefined
			? useAppStore.getState().beginCenterNavigation(workspaceId)
			: requestedNavigation;
	const requestedAt = navTick(workspaceId);
	if (intent === "preview") {
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_SETTLE_MS));
	}
	const state = useAppStore.getState();
	if (state.removedWorkspaceIds[workspaceId]) return;
	const overtaken = navigation
		? !isCenterNavigationCurrent(state, workspaceId, navigation)
		: navTick(workspaceId) !== requestedAt;
	if (intent === "preview" && overtaken) return;
	const id = changesTabId(workspaceId, scope);
	const revealPath = options.revealPath
		? projectRelativePath(options.revealPath, selectWorkspaceById(state, workspaceId)?.worktreePath)
		: null;
	const existing = (state.tabsByWorkspace[workspaceId] ?? []).find(
		(tab): tab is ChangesTab => tab.id === id && tab.kind === "changes",
	);
	const base = existing ?? createChangesTab(workspaceId, id, "", scope);
	const tab: ChangesTab = revealPath
		? { ...base, reveal: { path: revealPath, tick: (base.reveal?.tick ?? 0) + 1 } }
		: base;
	state.openTab(tab, intent, true, layoutOpenOptionsForNavigation(state, workspaceId, navigation));
}

/**
 * Follow Agent: shows `path` at `line` as a preview tab without taking focus or counting as navigation — the
 * conversation keeps the keyboard. With a `targetGroupId` (another group than the chat's) the tab is also
 * selected there and flashes the line; without one it only joins the strip, so a single-group layout never
 * swaps the conversation out from under the user.
 */
const userNavigationEpochs = new Map<string, number>();

/** Counts the user's manual navigation in a workspace's editors; a follow that began earlier must not reveal. */
export function noteUserNavigation(workspaceId: string): void {
	userNavigationEpochs.set(workspaceId, (userNavigationEpochs.get(workspaceId) ?? 0) + 1);
}

export function userNavigationEpoch(workspaceId: string): number {
	return userNavigationEpochs.get(workspaceId) ?? 0;
}

export async function followFileAtLine(
	workspaceId: string,
	path: string,
	line: number,
	targetGroupId?: string,
	/** Vetoes the select when the file already lives somewhere the caller must not surface (the chat's group). */
	canSelect: (tabId: string) => boolean = () => true,
	/** Re-checked once the file is open: false when the user paused or turned following off meanwhile. */
	stillFollowing: () => boolean = () => true,
): Promise<void> {
	// Canonicalize once so the tab, the reveal and the select intent all name the same file.
	const canonical = projectRelativePath(
		path,
		selectWorkspaceById(useAppStore.getState(), workspaceId)?.worktreePath,
	);
	if (!stillFollowing()) return;
	// The preview must not be installed over the user's own selection once they paused or navigated.
	await openFileInTab(
		workspaceId,
		canonical,
		"preview",
		null,
		{ activate: false, ...(targetGroupId ? { targetGroupId } : {}) },
		() => !stillFollowing(),
	);
	// Opening may have waited on a read; the user's pause or off switch wins over a stale follow.
	if (!stillFollowing()) return;
	useAppStore
		.getState()
		.revealFileTab(workspaceId, canonical, { line, flash: true }, SOURCE_RENDERER_ID);
	if (!targetGroupId) return;
	const state = useAppStore.getState();
	const tabId = tupleKey("file", workspaceId, canonical);
	if (!(state.tabsByWorkspace[workspaceId] ?? []).some((tab) => tab.id === tabId)) return;
	if (!canSelect(tabId)) return;
	state.enqueueLayoutIntent({
		kind: "select",
		workspaceId,
		tabId,
		focus: false,
		countNavigation: false,
	});
}
