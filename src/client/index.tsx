/**
 * Client half: the Verification section on the Settings page.
 *
 * The client cannot read Host state directly, so every value here arrives through a
 * Remote call. That is why the namespace is mounted before the section is
 * registered: a section registered against a namespace that does not exist renders
 * an empty panel, which looks exactly like a working install with nothing recorded.
 *
 * The panel has one control and two readings. The control is the verification mode;
 * the readings are what the verifier has seen and what has been remembered in this
 * workspace. Everything else is an observation the user should be able to audit
 * rather than set.
 *
 * @module dsh-cognitive-kernel/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-typert-registry/client'
import { INVOCATIONS, PACKAGE, SERVICE, type VerificationMode } from '../contract.ts'

/** One remembered observation, as the panel lists it. */
interface MemoryRow {
  readonly at: number
  readonly kind: string
  readonly text: string
  readonly source: string
}

/** What the Remote service reports. */
interface KernelState {
  readonly verification: VerificationMode
  readonly storeRoot: string
  readonly revision: number
  readonly workspace: string
  readonly productive: number
  readonly failures: number
  readonly memories: readonly MemoryRow[]
}

/**
 * The client-side Remote descriptors, from the shared contract.
 *
 * `$mount` uses them to install the `remote.cognitiveKernel` namespace service;
 * without a mount that namespace does not exist and every call below reads as a
 * missing method.
 */
const REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: INVOCATIONS,
}

/**
 * The `remote.cognitiveKernel` face this section calls.
 *
 * Declared here because the namespace is installed at run time by `$mount`, so no
 * ambient augmentation describes it.
 */
interface KernelRemoteFace {
  getState(): Promise<RemoteResult<KernelState>>
  setMode(mode: VerificationMode, expectedRevision: number): Promise<RemoteResult<KernelState>>
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'remote']

/** One verification mode, and what choosing it does. */
const MODES: readonly { id: VerificationMode; label: string; hint: string }[] = [
  {
    id: 'nudge',
    label: 'Nudge',
    hint: 'Answer an unverified completion claim with a demand for evidence. '
      + 'The turn continues either way.',
  },
  {
    id: 'strict',
    label: 'Strict',
    hint: 'Refuse the step when a completion claim has no evidence behind it. '
      + 'Stronger, and able to strand a turn if the claim was misread.',
  },
  {
    id: 'off',
    label: 'Off',
    hint: 'Do not check completion claims. Observations are still recorded.',
  },
]

/**
 * The section component.
 *
 * `remote` is captured rather than threaded through slot props: the Remote face is
 * a plugin-lifetime handle, and passing it as a prop would make the component
 * re-read a mutable lookup on every render.
 */
function KernelSection({ remote }: { readonly remote: KernelRemoteFace }) {
  return function KernelSectionView() {
    const [state, setState] = useState<KernelState | undefined>(undefined)
    const [error, setError] = useState<string | undefined>(undefined)
    const [busy, setBusy] = useState(false)

    const refresh = useCallback(async () => {
      const result = await remote.getState()
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setState(result.value)
      setError(undefined)
    }, [])

    useEffect(() => { void refresh() }, [refresh])

    /**
     * Change the mode.
     *
     * The revision from the last read travels with the write, so a write that lost
     * a race is rejected rather than silently discarding the other change. On
     * rejection the panel reloads and says so: reporting success for a write that
     * did not land is the one outcome worth failing loudly over.
     */
    const choose = useCallback(async (mode: VerificationMode) => {
      if (state === undefined) return
      setBusy(true)
      try {
        const result = await remote.setMode(mode, state.revision)
        if (!result.ok) {
          setError(`${result.error.message} The panel was reloaded; choose again.`)
          await refresh()
          return
        }
        setState(result.value)
        setError(undefined)
      } finally {
        setBusy(false)
      }
    }, [state, refresh])

    const title = <h2 key="title" className="ck-title">Verification</h2>

    if (state === undefined) {
      return (
        <div className="ck-section">
          {title}
          {error === undefined
            ? <p className="ck-muted">Loading…</p>
            : <p className="ck-error" role="alert">{error}</p>}
        </div>
      )
    }

    const active = MODES.find(mode => mode.id === state.verification)

    return (
      <div className="ck-section">
        {title}
        <p className="ck-muted">
          The harness checks what a completion claim asserts against what it saw
          happen, and reports the gap. It never asks a model whether its own work is
          done: a second opinion from the same kind of source is not verification,
          and the research on that is unanimous that it makes outcomes worse rather
          than better.
        </p>
        {error === undefined ? null : <p className="ck-error" role="alert">{error}</p>}

        <div className="ck-modes" role="radiogroup" aria-label="Verification mode">
          {MODES.map(mode => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={mode.id === state.verification}
              disabled={busy}
              className={mode.id === state.verification ? 'ck-button ck-on' : 'ck-button'}
              onClick={() => void choose(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {active === undefined ? null : <p className="ck-muted">{active.hint}</p>}

        <dl className="ck-stats">
          <dt>Workspace</dt>
          <dd>{state.workspace === '' ? 'no session in scope' : state.workspace}</dd>
          <dt>Failures recorded</dt>
          <dd>{state.failures}</dd>
          <dt>Successes recorded</dt>
          <dd>{state.productive}</dd>
        </dl>

        <h3 key="mem" className="ck-subtitle">Remembered here</h3>
        {state.memories.length === 0
          ? <p className="ck-muted">Nothing recorded for this workspace yet.</p>
          : (
            <ul className="ck-memories">
              {state.memories.map(entry => (
                <li key={`${entry.at}-${entry.text}`}>
                  <span className={entry.kind === 'failure' ? 'ck-kind ck-fail' : 'ck-kind'}>
                    {entry.kind}
                  </span>
                  {` ${entry.text}`}
                </li>
              ))}
            </ul>
          )}
        <p className="ck-muted">
          Memories are observations the harness made, not claims a model made. They
          are injected as prior context and never as instructions.
        </p>
      </div>
    )
  }
}

/**
 * Register the Verification section.
 *
 * The registration is wrapped in `slots.inject` so the section is re-registered
 * when the settings shell is replaced (a hot reload, or a shell that mounts after
 * this plugin), instead of registering once into a slot that may not exist yet and
 * silently rendering nothing.
 *
 * @param ctx - the browser plugin context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Mounting is what creates `remote.cognitiveKernel`; the namespace does not exist
  // until this resolves, and the panel would call a missing method if it were
  // registered first.
  await ctx.remote.$mount(REMOTE_CONTRIBUTION)
  const remote = ctx.get(`remote.${SERVICE}`) as KernelRemoteFace | undefined
  if (remote === undefined) {
    // Loud on purpose: a silently unmounted namespace renders a panel that looks
    // like a working install with nothing recorded, which is the failure this check
    // exists to prevent.
    throw new Error(`${PACKAGE}: remote.${SERVICE} did not mount`)
  }
  const Section = KernelSection({ remote })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SERVICE,
    order: 23,
    label: 'Verification',
  }, Section))
}
