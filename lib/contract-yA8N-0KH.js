import z from "@deepseek-ai/schemastery";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
//#region src/semantic.ts
/**
* Cosine similarity of two vectors.
*
* Returns 0 for a dimension mismatch or a zero-length vector rather than throwing:
* a stored vector from a different model version must degrade to "no signal" instead
* of breaking a recall path that a model is waiting on.
*
* @param a - the first vector.
* @param b - the second vector.
* @returns similarity in [-1, 1], or 0 when the vectors are not comparable.
*/
function cosine(a, b) {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < a.length; index += 1) {
		const x = a[index] ?? 0;
		const y = b[index] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
/**
* Build the text that represents an entry for retrieval.
*
* The gloss is not decoration and must not be dropped in favour of the raw text: the
* measurement in the module header is that the raw text alone loses to an unrelated
* distractor. The raw text is kept in the string because it carries identifiers a
* query may name literally — a path, a flag, an environment variable — and the gloss
* supplies the words a human would use to ask for it.
*
* @param text - the literal observation, such as the command that ran.
* @param gloss - the plain-language description of what it does and when to use it.
* @returns the text to embed.
*/
function embeddable(text, gloss) {
	const trimmedGloss = gloss.trim();
	if (trimmedGloss === "") return text;
	return `${text}\n${trimmedGloss}`;
}
/**
* The text that best represents a stored entry for retrieval.
*
* **Not** the human-readable prose. That prose exists to be read in a recall result and
* it carries boilerplate — the workspace path, "in", "the command", "succeeded" — which
* is shared by every entry in the workspace and therefore separates none of them.
* Measuring it against a distractor: embedding the prose plus the gloss scored 0.145
* where the distractor scored 0.131, a margin thin enough that the wrong entry won.
* Embedding the command plus the gloss on the same query scored 0.190, a clear win,
* because what distinguishes one entry from another is what it ran and what it is for.
*
* @param entry - an entry's command-like text and its gloss.
* @returns the text to embed for retrieval.
*/
function rememberable(entry) {
	return embeddable(commandOf(entry.text), entry.gloss ?? "");
}
/**
* Recover the command-like core from an entry's composed prose.
*
* The store composes readable sentences, and the quoted span inside backticks is the
* part worth embedding. When no quoted span is present the whole text is used, so an
* entry written by an older version of this package still ranks on something.
*
* @param text - the composed entry text.
* @returns the quoted span when there is one, otherwise the text unchanged.
*/
function commandOf(text) {
	return /`([^`]+)`/.exec(text)?.[1]?.trim() ?? text;
}
/**
* A large-language pattern that means the entry describes something *going wrong*.
*
* Failure entries and success entries answer opposite questions, so a query about a
* symptom must be able to rank failures above successes even when both mention the
* same tool. Checked against the gloss, which is where the outcome is stated in words
* a query will share.
*/
const SYMPTOM_PATTERNS = [
	/\bfail(?:ed|ure|s)?\b/i,
	/\berror(?:s|ed)?\b/i,
	/\bnot\s+found\b/i,
	/\bmissing\b/i,
	/\brejected\b/i,
	/\btimed?\s*out\b/i,
	/\brefus(?:ed|es)\b/i,
	/\bunable\b/i
];
/**
* Whether a query is asking about something that went wrong.
*
* @param query - the retrieval query.
* @returns true when the query describes a failure or a symptom.
*/
function asksAboutFailure(query) {
	return SYMPTOM_PATTERNS.some((pattern) => pattern.test(query));
}
/**
* Rank entries against a query by embedding similarity.
*
* Similarity alone is not the score. A query about a symptom is boosted for entries
* that record a failure, and damped for entries that record a success, because those
* answer opposite questions — a user asking why something broke is not helped by the
* command that works.
*
* The adjustment is **multiplicative**, which matters and is not a detail. An additive
* boost lets a nearly-irrelevant failure outrank a perfect success: with cosine 0.2 and
* a flat +0.05 the failure reaches 0.25, and it beats a success at 0.24. Scaling instead
* keeps the ordering of similarity intact and only widens gaps that already exist, so
* the adjustment can separate close entries without ever manufacturing a winner from a
* weak match. That is the same failure the module exists to avoid — a plausible wrong
* entry presented as the answer — and an additive bonus reintroduces it by hand.
*
* @param query - the retrieval query.
* @param entries - candidate entries with their precomputed vectors.
* @param queryVector - the query's vector.
* @param limit - maximum entries to return.
* @returns entries above the relevance floor, highest score first.
*/
function rank(query, entries, queryVector, limit) {
	const aboutFailure = asksAboutFailure(query);
	return entries.map((entry) => {
		const similarity = cosine(queryVector, entry.vector);
		let score = similarity;
		if (aboutFailure) {
			if (entry.kind === "failure") score = similarity * 1.15;
			else if (entry.kind === "success") score = similarity * .85;
		}
		return {
			...entry,
			score,
			similarity
		};
	}).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
//#endregion
//#region src/secrets.ts
/**
* Keep credentials out of the durable memory store.
*
* The store records the first line of every failed command, and commands carry
* secrets: a bearer token in a `curl` header, a password in a database URL, an
* API key exported before a test run. Without this module those land in a
* plaintext JSON Lines file and are re-injected into a later turn's context by
* recall, which turns a memory feature into a credential log with a long
* retention period and no access control.
*
* Two properties are deliberate and worth preserving in any edit.
*
* The gate is unconditional. There is no setting that disables it and no caller
* that can opt out, because a redaction policy a caller may skip is one a caller
* will eventually skip. {@link MemoryStore.append} applies it to every entry
* regardless of how the text was composed.
*
* The failure mode is dropping the entry, not storing a partial redaction. When
* a span is recognised it is replaced; when text still looks secret-bearing
* afterwards the entry is refused outright. The costs are asymmetric — a dropped
* memory costs one lesson a future session can re-derive, while a leaked key
* costs a credential rotation and possibly more — so the tie is broken toward
* dropping every time.
*/
/** Marker left in place of a redacted span. */
const REDACTED = "[redacted]";
/**
* Credential shapes recognised by their own syntax, independent of context.
*
* These are issuer prefixes and structural formats that do not occur by accident:
* a string starting `ghp_` is a GitHub token or it is nothing. Matching them
* directly catches the case that assignment-based detection misses, where a key
* is passed as a bare positional argument with no `KEY=` or `--flag` around it.
*/
const CREDENTIAL_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{2,}-[A-Za-z0-9_-]{16,}\b/g,
	/\bsk-[A-Za-z0-9]{16,}\b/g,
	/\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bglpat-[A-Za-z0-9_-]{16,}\b/g,
	/\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
	/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\bnpm_[A-Za-z0-9]{36}\b/g,
	/\bdop_v1_[a-f0-9]{64}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/-----BEGIN[A-Z ]*PRIVATE KEY-----/g
];
/**
* Credentials recognised by the syntax that assigns them rather than their own
* shape, since a password has no distinguishing format of its own.
*
* Each pattern captures the name or flag so it can be preserved. `PGPASSWORD` is
* more useful in the stored text than `[redacted]=[redacted]`, and keeping the
* name is what lets a future session recognise the lesson without learning the
* value.
*/
const ASSIGNMENT_PATTERNS = [
	/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|PAT)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
	/(--(?:password|passwd|token|secret|api-?key|access-?key|auth|credential)(?:[= ]))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
	/(\bauthorization\s*:\s*(?:bearer|basic|token)\s+)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/gi,
	/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi
];
/**
* An unrecognised token long and varied enough that it may be a credential.
*
* Requiring all three of lowercase, uppercase and a digit is what keeps this from
* firing on the things that actually appear in commands: a 40-character git SHA is
* lowercase hexadecimal and does not match, nor does a lowercase file path, nor a
* SCREAMING_SNAKE_CASE constant. A base64 blob does match, and is refused, which is
* the intended trade.
*/
const RESIDUAL_PATTERN = new RegExp(`[A-Za-z0-9+/=_-]{${String(24)},}`, "g");
/**
* Replace every recognised credential span in `text`.
*
* Redaction runs before the residual check so that a command whose secret is
* recognised keeps its useful shape: `curl -H 'Authorization: Bearer [redacted]'`
* still tells a future session which endpoint failed and how it was called.
*
* @param text - the text to redact.
* @returns the text with recognised credentials replaced by {@link REDACTED}.
*/
function redact(text) {
	let result = text;
	for (const pattern of CREDENTIAL_PATTERNS) result = result.replace(pattern, REDACTED);
	for (const pattern of ASSIGNMENT_PATTERNS) result = result.replace(pattern, (_match, prefix, suffix) => {
		const tail = typeof suffix === "string" ? suffix : "";
		return `${prefix}${/[=: ]$/.test(prefix) ? "" : "="}${REDACTED}${tail}`;
	});
	return result;
}
/**
* Whether text still contains a token that could be a credential after redaction.
*
* Spans already replaced by {@link REDACTED} are excluded, so a fully redacted
* command passes even though the marker itself is otherwise unremarkable.
*
* @param text - redacted text to inspect.
* @returns true when an unrecognised high-variety token remains.
*/
function hasResidualSecret(text) {
	const matches = text.split(REDACTED).join(" ").match(RESIDUAL_PATTERN);
	if (matches === null) return false;
	return matches.some((token) => /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token));
}
/**
* Produce the form of `text` that is safe to write to the durable store.
*
* This is the only function callers need: it redacts what it recognises and
* refuses what it cannot vouch for.
*
* @param text - the composed entry text.
* @returns the redacted text, or `undefined` when the entry must not be stored.
*/
function safeForStorage(text) {
	const redacted = redact(text);
	if (hasResidualSecret(redacted)) return void 0;
	return redacted;
}
//#endregion
//#region src/memory.ts
/**
* Durable memory: what the harness decides is worth keeping across sessions.
*
* **This is not an accuracy feature.** That is the most important thing the
* research establishes, and it contradicts the intuition that a memory layer makes
* an agent smarter. The strongest published system in this space reports its own
* full-context baseline beating it: Mem0's Table 2 has full-context at 72.90%
* against Mem0 at 66.88%. What a memory layer buys is not better answers — it is
* bounded tokens and lower latency on unbounded history. Treating it as an accuracy
* lever would mean shipping cost and complexity for a claimed benefit that the
* literature does not support.
*
* So this store is justified narrowly and must be measured narrowly. Its value is:
*
*   1. A failure observed in one session is not repeated blind in the next. This is
*      the procedural case, which is where the evidence is strongest — Voyager and
*      Agent Workflow Memory both move *executable* artifacts and both transfer.
*   2. Context that would otherwise have to be re-derived is available cheaply.
*
* What it deliberately is NOT:
*
*   Not a transcript. `session-query` already stores and full-text searches every
*   session, so hand-authoring raw episodic recall here would duplicate an existing
*   index at worse fidelity. Raw recall is a retrieval problem, and it is where the
*   accuracy case is weakest.
*
*   Not model-authored. Every entry traces to an observation in `evidence.ts`.
*   Storing what a model *said* would make memory a write channel for confident
*   falsehoods, and the injection literature is blunt about the cost: an attacker
*   who never writes to memory can achieve high injection success through queries
*   alone. Retrieved memory is therefore framed as untrusted data, never as
*   instructions.
*
*   Not unbounded. Retrieval is capped and relevance-filtered, because a single
*   plausible-looking irrelevant document measurably degrades performance, and
*   accumulated distractors are worse still.
*
* The acceptance test this module must pass: it has to beat the baseline of
* full-context plus plain grep over the session log. If it cannot, it is not worth
* its tokens and should be deleted rather than tuned.
*
* @module dsh-cognitive-kernel/memory
*/
/**
* Decide whether an observation is worth remembering.
*
* The policy writes far less than feels natural, because the store's value is in
* the entries a future session will actually act on. Failures and verified
* successful commands qualify: they are procedural knowledge, which is the one
* category with demonstrated cross-task transfer. Reads and ordinary file writes do
* not — the former carry no reusable knowledge, the latter are checkable on demand
* and would crowd out real lessons.
*
* @param observation - the observation to judge.
* @returns the kind to record, or `undefined` when it is not memorable.
*/
function memoryKindOf(observation) {
	if (observation.subject === void 0) return void 0;
	if (!observation.ok) return "failure";
	if (observation.tool === "bash" || observation.tool === "pwsh") return "success";
}
/**
* Compose the sentence stored for an entry.
*
* Written so that a future session reads a fact about the world rather than a
* narration of a past session. "The command `pnpm test` failed in this
* workspace" is useful; "I tried running tests and it did not work" is not,
* because it invites the model to reason about a past agent rather than about the
* code.
*
* @param kind - the entry kind.
* @param observation - the source observation.
* @param cwd - the working directory the observation was made in.
* @returns the composed text.
*/
function composeText(kind, observation, cwd) {
	const subject = observation.subject ?? "";
	switch (kind) {
		case "failure": return `In ${cwd}, the command \`${subject}\` failed. It is worth checking why before repeating it.`;
		case "success": return `In ${cwd}, the command \`${subject}\` succeeded.`;
		case "artifact": return `In ${cwd}, the path ${subject} exists.`;
	}
}
/**
* Compose the words a future query is likely to use for this entry.
*
* This is the field that makes semantic search work, and it exists because of a
* measurement: a small embedding model ranks by vocabulary, so on the corpus that
* motivated this module the query "how do I typecheck the project" scored the command
* that solves it at 0.078 while scoring an unrelated failure narrative at 0.153. The
* command lost because the narrative shared words with the query and `npx tsc --noEmit`
* shares none. Naming what the entry is *for*, in the terms a person would ask with,
* moved that entry to 0.258 and flipped the order.
*
* The vocabulary is deliberately ordinary and redundant. "check", "verify", "test"
* and "correct" all appear for a test command because the query may say any of them,
* and a missed synonym is a miss no ranking can repair.
*
* @param kind - what kind of fact the entry records.
* @param observation - the observation it came from.
* @returns the gloss.
*/
function composeGloss(kind, observation) {
	const subject = observation.subject ?? "";
	const ran = observation.subject !== void 0;
	switch (kind) {
		case "failure": return [
			"a command or step that did not work, an error, a failure to reproduce and avoid",
			ran ? `check whether ${subject} works` : "",
			"debug, diagnose, troubleshoot, why did this break, what went wrong",
			"the operation was refused, rejected or did not apply"
		].filter(Boolean).join("; ");
		case "success": return [
			"a known-good command that worked and can be run again",
			ran ? `how to run ${subject}` : "",
			"check the code is correct, verify behaviour, run the tests, typecheck, build",
			"the working invocation, the proven procedure, the recipe that succeeds"
		].filter(Boolean).join("; ");
		case "artifact": return [
			"a file or path that exists in this workspace",
			ran ? `find or open ${subject}` : "",
			"where is it, what was created, the output location"
		].filter(Boolean).join("; ");
	}
}
/**
* The durable memory store, as one append-only JSON Lines file per workspace.
*
* JSONL rather than a single JSON document because appends are atomic enough to
* survive a crash mid-write, a corrupt tail costs one entry rather than the file,
* and the format is greppable without this plugin being loaded — which matters for
* a store a human may need to inspect or repair.
*
* Keyed by working directory because relevance is overwhelmingly local: a lesson
* about a failing command in one repository is usually noise in another.
*/
var MemoryStore = class {
	#root;
	/**
	* @param root - directory to hold the store; created on first write.
	*/
	constructor(root) {
		this.#root = root;
	}
	/**
	* Path of the store file for one workspace.
	*
	* The directory name is a hash so that any path, including one with separators
	* or characters a filesystem rejects, maps to a valid single-segment name.
	*
	* @param cwd - the workspace directory.
	* @returns the absolute file path.
	*/
	fileFor(cwd) {
		return join(this.#root, `${hashPath(cwd)}.jsonl`);
	}
	/**
	* Append one entry, creating the store on first use.
	*
	* @param entry - the entry to append.
	*/
	async append(entry) {
		const text = safeForStorage(entry.text);
		if (text === void 0) return;
		const gloss = entry.gloss === void 0 ? void 0 : safeForStorage(entry.gloss);
		if (entry.gloss !== void 0 && gloss === void 0) return;
		const safe = {
			...entry,
			text,
			...gloss === void 0 ? {} : { gloss }
		};
		const file = this.fileFor(safe.cwd);
		await mkdir(dirname(file), { recursive: true });
		await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8");
	}
	/**
	* Read every entry for one workspace.
	*
	* A malformed line is skipped rather than throwing. A store that cannot be read
	* because one append was torn is worse than a store that loses one entry, and
	* the caller has no repair path.
	*
	* @param cwd - the workspace directory.
	* @returns the entries, oldest first.
	*/
	async read(cwd) {
		let raw;
		try {
			raw = await readFile(this.fileFor(cwd), "utf8");
		} catch {
			return [];
		}
		const entries = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed = JSON.parse(line);
				if (isEntry(parsed)) entries.push(parsed);
			} catch {}
		}
		return entries;
	}
	/**
	* Rank entries by meaning, computing any missing vectors.
	*
	* A missing vector is not a reason to skip an entry: an entry written before the
	* model existed is still knowledge, so its vector is computed on demand and the
	* ranking proceeds over the whole corpus. The embed of the query happens once, which
	* is the difference between one model call per recall and one per entry.
	*
	* @param entries - every entry in the workspace.
	* @param query - the retrieval query.
	* @param limit - maximum entries to return.
	* @param embedder - the embedder to use.
	* @returns ranked entries, or an empty list when nothing was embeddable.
	*/
	async recallSemantically(entries, query, limit, embedder) {
		try {
			const queryVector = await embedder(query);
			return rank(query, await Promise.all(entries.map(async (entry) => {
				if (entry.vector !== void 0 && entry.vector.length > 0) return {
					entry,
					vector: entry.vector,
					kind: entry.kind
				};
				return {
					entry,
					vector: await embedder(rememberable(entry)),
					kind: entry.kind
				};
			})), queryVector, limit).map((hit) => hit.entry);
		} catch {
			return [];
		}
	}
	/**
	* Select the entries most likely to matter for a query.
	*
	* Two retrieval paths, tried in order, because they fail in opposite directions and
	* each covers the other.
	*
	* **Semantic first**, when an embedder is provided. It is what makes a query phrased
	* in a user's own words find an entry that shares none of them: measured at 6 of 6
	* on a corpus where lexical scored 1 of 6. Embedding dominates the cost, so vectors
	* are read from the entries where present and computed once for the query.
	*
	* **Lexical as the fallback**, and not merely as a courtesy. A deployment without the
	* bundled model, a corpus written before it was added, or an embed failure mid-recall
	* all have to keep working. Terms are matched on the text *and* the gloss, since the
	* gloss is where a human's words live.
	*
	* @param cwd - the workspace directory.
	* @param query - what the caller is about to do.
	* @param limit - maximum entries to return.
	* @param embedder - an embedder, or nothing to stay lexical.
	* @returns the selected entries.
	*/
	async recall(cwd, query, limit = 5, embedder) {
		const entries = await this.read(cwd);
		if (entries.length === 0) return [];
		if (embedder !== void 0) {
			const semantic = await this.recallSemantically(entries, query, limit, embedder);
			if (semantic.length > 0) return semantic;
		}
		const terms = new Set(query.toLowerCase().split(/[^a-z0-9_./-]+/).filter((term) => term.length > 2));
		if (terms.size === 0) return entries.slice(-limit).reverse();
		return entries.map((entry, index) => {
			const haystack = `${entry.text}\n${entry.gloss ?? ""}`.toLowerCase();
			let relevance = 0;
			for (const term of terms) if (haystack.includes(term)) relevance += 1;
			let score = relevance;
			if (relevance > 0) {
				if (entry.kind === "failure") score += .5;
				score += index / (entries.length * 100);
			}
			return {
				entry,
				score,
				relevance
			};
		}).filter((item) => item.relevance > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.entry);
	}
};
/**
* Whether a parsed value is a memory entry.
*
* Validating on read rather than trusting the file matters because the store is
* plain text a human can edit, and a malformed entry that reached the model would
* be worse than a skipped one.
*
* @param value - the parsed value.
* @returns true when it has every field with the right type.
*/
function isEntry(value) {
	if (value === null || typeof value !== "object") return false;
	const record = value;
	return typeof record.at === "number" && typeof record.session === "string" && typeof record.cwd === "string" && typeof record.kind === "string" && typeof record.text === "string" && typeof record.source === "string";
}
/**
* A stable, filesystem-safe name for a workspace path.
*
* A plain hash rather than the path itself: paths contain separators, can be very
* long, and on a case-insensitive filesystem two different paths can collide when
* used as a filename.
*
* @param path - the workspace path.
* @returns a short hex digest.
*/
function hashPath(path) {
	let hash = 2166136261;
	for (let index = 0; index < path.length; index += 1) {
		hash ^= path.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
//#endregion
//#region src/contract.ts
/** Settings namespace this plugin owns. */
const SETTINGS_NAMESPACE = "cognitive-kernel";
/** Package name, stamped into every invocation id. */
const PACKAGE = "dsh-cognitive-kernel";
/** The service name, which is also its Remote namespace. */
const SERVICE = "cognitiveKernel";
/** One verification mode. */
const modeSchema = z.union([
	z.const("nudge"),
	z.const("strict"),
	z.const("off")
]).required();
/** One memory entry as both halves describe it. */
const memorySchema = z.object({
	at: z.natural(),
	kind: z.string(),
	text: z.string(),
	source: z.string()
});
/** One observed tool outcome, as the panel reports it. */
const observationSchema = z.object({
	tool: z.string(),
	ok: z.boolean(),
	mutating: z.boolean(),
	subject: z.union([z.string(), z.const("")]).default("")
});
/**
* The full state payload.
*
* Carries a live sample rather than a log dump: the panel's job is to show what
* the verifier currently believes and what has been remembered, not to replay the
* session. A `supported` count is reported instead of a verdict, because a verdict
* depends on a specific claim and there is no current claim to judge.
*/
const stateSchema = z.object({
	verification: modeSchema,
	storeRoot: z.string(),
	revision: z.natural(),
	/** Workspace the sample was read from, or '' when no agent was in scope. */
	workspace: z.string(),
	/** Successful mutating observations in the sample. */
	productive: z.natural(),
	/** Failed observations in the sample. */
	failures: z.natural(),
	/** Most recent observations, newest last, capped by the Host. */
	observations: z.array(observationSchema),
	/** Most recent durable memories for the workspace. */
	memories: z.array(memorySchema)
});
/**
* The stored settings shape.
*
* `verification` is the whole of this plugin's user state. It is a settings field
* rather than plugin config so the choice persists across restarts, is revisioned
* for conflict detection, and can be edited by hand.
*/
const settingsSchema = z.object({ verification: modeSchema });
/**
* Wrap a schemastery schema in the `{ parse }` shape a codec requires.
*
* Schemastery validates through Standard Schema, whose result may be async; these
* schemas are all synchronous, so an async result is a programming error rather
* than something to await at a synchronous codec boundary.
*/
function parser(schema) {
	return { parse(value) {
		const result = schema["~standard"].validate(value);
		if ("issues" in result) throw new TypeError(`cognitive-kernel codec rejected a value: ${JSON.stringify(result.issues)}`);
		return result.value;
	} };
}
/** One strict codec over a schemastery schema. */
function codec(schema) {
	return {
		mode: "strict",
		typeSymbol: "CognitiveKernelPayload",
		schema: parser(schema)
	};
}
/** The codec for one verification mode. */
const modeCodec = codec(modeSchema);
/** The codec for a revision number. */
const revisionCodec = codec(z.natural());
/** The codec for the full state payload. */
const stateCodec = codec(stateSchema);
/**
* The invocation descriptors, defined once for both halves.
*
* The Host registers them so the gateway can route calls; the client mounts them
* so the `remote.cognitiveKernel` namespace exists. Identical ids on both sides
* are what pair them, so a typo here fails as an unroutable call rather than as
* silently mismatched methods.
*/
const INVOCATIONS = [{
	id: `${PACKAGE}#${SERVICE}/getState`,
	service: SERVICE,
	namespace: SERVICE,
	method: "getState",
	invocation: { kind: "direct" },
	parameters: [],
	result: stateCodec
}, {
	id: `${PACKAGE}#${SERVICE}/setMode`,
	service: SERVICE,
	namespace: SERVICE,
	method: "setMode",
	invocation: { kind: "direct" },
	parameters: [{
		name: "mode",
		wire: "mode",
		source: "json",
		codec: modeCodec
	}, {
		name: "expectedRevision",
		wire: "expectedRevision",
		source: "json",
		codec: revisionCodec
	}],
	result: stateCodec
}];
//#endregion
export { settingsSchema as a, composeText as c, SETTINGS_NAMESPACE as i, memoryKindOf as l, PACKAGE as n, MemoryStore as o, SERVICE as r, composeGloss as s, INVOCATIONS as t, rememberable as u };
