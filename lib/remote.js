import { a as settingsSchema, i as SETTINGS_NAMESPACE, n as PACKAGE, o as MemoryStore, r as SERVICE, t as INVOCATIONS } from "./contract-yA8N-0KH.js";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region src/remote.ts
/**
* Remote half: the Host service the Settings page reads and writes.
*
* The client cannot read Host state directly. It calls a Remote service, and the
* api-gateway routes that call by looking the service up in the ROOT service
* table. That is why `cordis.patch.yml` registers this as its own top-level row
* rather than nesting it inside the main plugin: a Remote registration inside
* another plugin's scope is invisible to the gateway, and the Settings page then
* reports a service it cannot reach.
*
* The verification mode lives in DSH settings rather than in this plugin's config,
* so the choice is revisioned, conflict-checked, and visible to the user. The
* revision is compared on every write: if the stored revision moved since the
* client read it, the write is rejected rather than silently clobbering a change
* made elsewhere (a second tab, or a hand edit of the settings file).
*
* @module dsh-cognitive-kernel/remote
*/
/**
* The Typert contribution.
*
* The invocation descriptors come from the shared contract module rather than
* being written here, so the ids the gateway routes and the ids the client mounts
* cannot drift apart.
*/
const TYPERT = {
	package: PACKAGE,
	face: "host",
	schemas: [],
	model: {
		services: [],
		events: [],
		objects: []
	},
	invocations: INVOCATIONS
};
/**
* Where the panel reads memories from and how many it shows.
*
* The store root is resolved here rather than read from the running plugin's
* config because the Remote row and the plugin row are separate Cordis entries
* with no shared handle. A mismatch would show the user an empty panel while
* memories accumulated elsewhere, so the path is fixed in one place both rows
* agree on.
*/
const STORE_ROOT = ".dsh-cognitive-kernel";
var CognitiveKernelRemote = class extends TypertRemoteService {
	static inject = ["settings", "typert"];
	/** The registered namespace handle, present once `settings` is available. */
	settings;
	constructor(ctx) {
		super(ctx, SERVICE);
		ctx.typert.register(TYPERT);
		ctx.inject(["settings"], (settingsCtx) => {
			this.settings = settingsCtx.settings.register(SETTINGS_NAMESPACE, settingsSchema, { base: { verification: "nudge" } });
		});
	}
	/**
	* The current state, for the settings panel.
	*
	* Reports a live sample rather than a verdict: whether a claim is supported
	* depends on a specific claim, and at read time there is no claim to judge. What
	* the panel can honestly show is what the verifier has seen and what has been
	* remembered, so it shows that.
	*/
	async getState() {
		const verification = this.mode();
		const cwd = this.workspace();
		const store = new MemoryStore(STORE_ROOT);
		const memories = cwd === null ? [] : (await store.read(cwd)).slice(-8).reverse();
		return {
			verification,
			storeRoot: STORE_ROOT,
			revision: this.revision(),
			workspace: cwd ?? "",
			productive: memories.filter((entry) => entry.kind === "success").length,
			failures: memories.filter((entry) => entry.kind === "failure").length,
			observations: [],
			memories: memories.map((entry) => ({
				at: entry.at,
				kind: entry.kind,
				text: entry.text,
				source: entry.source
			}))
		};
	}
	/**
	* Change the verification mode, rejecting the write if the revision moved.
	*
	* @param mode - the desired mode.
	* @param expectedRevision - the revision the client read.
	*/
	async setMode(mode, expectedRevision) {
		await this.ctx.settings.mutate(SETTINGS_NAMESPACE, [{
			op: "set",
			path: ["verification"],
			value: mode
		}], expectedRevision);
		return await this.getState();
	}
	/**
	* The workspace to read memories for.
	*
	* A running agent's session carries it; with no agent in scope there is no
	* workspace, and reporting `null` is more honest than showing the process
	* directory's memories as if they were the user's.
	*
	* @returns an absolute path, or `null`.
	*/
	workspace() {
		try {
			const list = this.ctx.get("agents")?.list?.() ?? [];
			for (const agent of list) {
				const cwd = agent.session?.header?.cwd;
				if (typeof cwd === "string" && cwd !== "") return cwd;
			}
		} catch {}
		return null;
	}
	/** The stored verification mode, or the default for a fresh install. */
	mode() {
		const stored = this.settings?.get()?.verification;
		return stored === "strict" || stored === "off" || stored === "nudge" ? stored : "nudge";
	}
	/** The current revision of this plugin's settings namespace. */
	revision() {
		const descriptor = this.ctx.settings.describe().find((candidate) => candidate.ns === SETTINGS_NAMESPACE);
		if (descriptor === void 0) return 0;
		return descriptor.revision;
	}
};
//#endregion
export { CognitiveKernelRemote as default };
