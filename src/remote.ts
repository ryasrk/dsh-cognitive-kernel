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

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.settings` and `ctx.typert` augmentations.
import type {} from '@deepseek-ai/dsh-settings'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { MemoryStore } from './memory.ts'
import {
  INVOCATIONS,
  PACKAGE,
  SETTINGS_NAMESPACE,
  SERVICE,
  settingsSchema,
  type VerificationMode,
} from './contract.ts'

/**
 * The Typert contribution.
 *
 * The invocation descriptors come from the shared contract module rather than
 * being written here, so the ids the gateway routes and the ids the client mounts
 * cannot drift apart.
 */
const TYPERT: TypertContribution = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: INVOCATIONS,
}

/**
 * Where the panel reads memories from and how many it shows.
 *
 * The store root is resolved here rather than read from the running plugin's
 * config because the Remote row and the plugin row are separate Cordis entries
 * with no shared handle. A mismatch would show the user an empty panel while
 * memories accumulated elsewhere, so the path is fixed in one place both rows
 * agree on.
 */
const STORE_ROOT = '.dsh-cognitive-kernel'

/** Cap on rows returned to the panel. A settings page is not a log viewer. */
const PANEL_LIMIT = 8

export default class CognitiveKernelRemote extends TypertRemoteService {
  static inject = ['settings', 'typert']

  /** The registered namespace handle, present once `settings` is available. */
  private settings: { get(): { verification: VerificationMode } } | undefined

  constructor(ctx: Context) {
    super(ctx, SERVICE)
    ctx.typert.register(TYPERT)
    // Registering the namespace is what makes it readable and writable:
    // `settings.get` returns undefined for an unregistered namespace, and
    // `settings.mutate` rejects one. The base supplies the default so a fresh
    // install needs no stored document.
    ctx.inject(['settings'], settingsCtx => {
      this.settings = settingsCtx.settings.register(
        SETTINGS_NAMESPACE,
        settingsSchema,
        { base: { verification: 'nudge' } },
      )
    })
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
    const verification = this.mode()
    // The panel reads the workspace from a live agent when one exists. `cwd` is
    // absent for a session created without one, and the store keys on it, so an
    // absent cwd genuinely has no memories rather than a default bucket's.
    const cwd = this.workspace()
    const store = new MemoryStore(STORE_ROOT)
    const memories = cwd === null ? [] : (await store.read(cwd)).slice(-PANEL_LIMIT).reverse()
    return {
      verification,
      storeRoot: STORE_ROOT,
      revision: this.revision(),
      // '' rather than null: the contract's schema has no nullable, and an empty
      // string is the honest encoding of "no workspace in scope" here.
      workspace: cwd ?? '',
      // The panel does not have the observation history (it lives in the plugin
      // row's memory), so these count what memory recorded: a durable record of a
      // productive change is the same kind of evidence the verifier counts.
      productive: memories.filter(entry => entry.kind === 'success').length,
      failures: memories.filter(entry => entry.kind === 'failure').length,
      observations: [],
      memories: memories.map(entry => ({
        at: entry.at,
        kind: entry.kind,
        text: entry.text,
        source: entry.source,
      })),
    }
  }

  /**
   * Change the verification mode, rejecting the write if the revision moved.
   *
   * @param mode - the desired mode.
   * @param expectedRevision - the revision the client read.
   */
  async setMode(mode: VerificationMode, expectedRevision: number) {
    await this.ctx.settings.mutate(
      SETTINGS_NAMESPACE,
      [{ op: 'set', path: ['verification'], value: mode }],
      expectedRevision,
    )
    return await this.getState()
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
  private workspace(): string | null {
    try {
      const agents = this.ctx.get('agents') as
        | { list?(): readonly { session?: { header?: { cwd?: string } } }[] }
        | undefined
      const list = agents?.list?.() ?? []
      for (const agent of list) {
        const cwd = agent.session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return cwd
      }
    } catch {
      // A service that is absent or shaped unexpectedly must not break the panel.
    }
    return null
  }

  /** The stored verification mode, or the default for a fresh install. */
  private mode(): VerificationMode {
    const stored = this.settings?.get()?.verification
    return stored === 'strict' || stored === 'off' || stored === 'nudge' ? stored : 'nudge'
  }

  /** The current revision of this plugin's settings namespace. */
  private revision(): number {
    const descriptor = this.ctx.settings
      .describe()
      .find(candidate => candidate.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) {
      // The namespace only appears once something is stored. Revision 0 is
      // correct for that state, and a read must not fail over it.
      return 0
    }
    return descriptor.revision
  }
}
