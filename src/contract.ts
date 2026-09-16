/**
 * The cognitive-kernel wire contract, shared by both halves.
 *
 * The Host declares these schemas to validate what leaves the service; the client
 * declares the same ones to validate what arrives. Both derive from one
 * definition, so a field added here cannot be validated on one side and silently
 * dropped on the other.
 *
 * This module is imported by the Node half and the browser half. It must stay free
 * of `node:` imports and of any Host-only service for that reason.
 *
 * @module dsh-cognitive-kernel/contract
 */

import type { TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

/** Settings namespace this plugin owns. */
export const SETTINGS_NAMESPACE = 'cognitive-kernel'

/** Package name, stamped into every invocation id. */
export const PACKAGE = 'dsh-cognitive-kernel'

/** The service name, which is also its Remote namespace. */
export const SERVICE = 'cognitiveKernel'

/**
 * How a bare completion claim is treated.
 *
 * `nudge` appends a demand for evidence and lets the turn continue. `strict`
 * refuses the step. `off` does nothing. The default is `nudge`: a harness that can
 * block a turn can deadlock one, and a refusal caused by a heuristic misreading a
 * sentence is a worse failure than an unverified claim.
 */
export const verificationModes = ['nudge', 'strict', 'off'] as const

/** One verification mode. */
export type VerificationMode = typeof verificationModes[number]

/** One verification mode. */
export const modeSchema = z.union([
  z.const('nudge'),
  z.const('strict'),
  z.const('off'),
]).required()

/** One memory entry as both halves describe it. */
export const memorySchema = z.object({
  at: z.natural(),
  kind: z.string(),
  text: z.string(),
  source: z.string(),
})

/** One observed tool outcome, as the panel reports it. */
export const observationSchema = z.object({
  tool: z.string(),
  ok: z.boolean(),
  mutating: z.boolean(),
  // A union with an empty object is how an absent field is expressed here:
  // schemastery has no `optional` modifier.
  subject: z.union([z.string(), z.const('')]).default(''),
})

/**
 * The full state payload.
 *
 * Carries a live sample rather than a log dump: the panel's job is to show what
 * the verifier currently believes and what has been remembered, not to replay the
 * session. A `supported` count is reported instead of a verdict, because a verdict
 * depends on a specific claim and there is no current claim to judge.
 */
export const stateSchema = z.object({
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
  memories: z.array(memorySchema),
})

/**
 * The stored settings shape.
 *
 * `verification` is the whole of this plugin's user state. It is a settings field
 * rather than plugin config so the choice persists across restarts, is revisioned
 * for conflict detection, and can be edited by hand.
 */
export const settingsSchema = z.object({
  verification: modeSchema,
})

/**
 * Wrap a schemastery schema in the `{ parse }` shape a codec requires.
 *
 * Schemastery validates through Standard Schema, whose result may be async; these
 * schemas are all synchronous, so an async result is a programming error rather
 * than something to await at a synchronous codec boundary.
 */
function parser<Output>(schema: {
  '~standard': { validate(value: unknown): unknown }
}): { parse(value: unknown): Output } {
  return {
    parse(value: unknown): Output {
      const result = schema['~standard'].validate(value) as
        | { readonly value: Output }
        | { readonly issues: readonly unknown[] }
      if ('issues' in result) {
        // The codec contract has no issue channel, so a rejected boundary value
        // must throw; the issues are kept in the message so the failing path is
        // readable rather than a bare "invalid".
        throw new TypeError(`cognitive-kernel codec rejected a value: ${JSON.stringify(result.issues)}`)
      }
      return result.value
    },
  }
}

/** One strict codec over a schemastery schema. */
function codec<Output>(schema: {
  '~standard': { validate(value: unknown): unknown }
}): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol: 'CognitiveKernelPayload',
    schema: parser<Output>(schema) as TypertSchema,
  }
}

/** The codec for one verification mode. */
export const modeCodec = codec<VerificationMode>(modeSchema)

/** The codec for a revision number. */
export const revisionCodec = codec<number>(z.natural())

/** The codec for the full state payload. */
export const stateCodec = codec<unknown>(stateSchema)

/**
 * The invocation descriptors, defined once for both halves.
 *
 * The Host registers them so the gateway can route calls; the client mounts them
 * so the `remote.cognitiveKernel` namespace exists. Identical ids on both sides
 * are what pair them, so a typo here fails as an unroutable call rather than as
 * silently mismatched methods.
 */
export const INVOCATIONS = [
  {
    id: `${PACKAGE}#${SERVICE}/getState`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'getState',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: stateCodec,
  },
  {
    id: `${PACKAGE}#${SERVICE}/setMode`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'setMode',
    invocation: { kind: 'direct' as const },
    parameters: [
      { name: 'mode', wire: 'mode', source: 'json' as const, codec: modeCodec },
      {
        name: 'expectedRevision',
        wire: 'expectedRevision',
        source: 'json' as const,
        codec: revisionCodec,
      },
    ],
    result: stateCodec,
  },
]
