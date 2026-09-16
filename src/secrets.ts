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
export const REDACTED = '[redacted]'

/**
 * Credential shapes recognised by their own syntax, independent of context.
 *
 * These are issuer prefixes and structural formats that do not occur by accident:
 * a string starting `ghp_` is a GitHub token or it is nothing. Matching them
 * directly catches the case that assignment-based detection misses, where a key
 * is passed as a bare positional argument with no `KEY=` or `--flag` around it.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // OpenAI, DeepSeek, Anthropic and compatible `sk-` issuers, including the
  // `sk-proj-` and `sk-ant-` variants.
  /\bsk-[A-Za-z0-9_-]{2,}-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  // Stripe live and restricted keys.
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // GitHub personal access, OAuth, user, server and refresh tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // GitLab.
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  // Slack bot, user, app, refresh and legacy tokens.
  /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key identifiers.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // npm automation tokens.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // DigitalOcean.
  /\bdop_v1_[a-f0-9]{64}\b/g,
  // JSON Web Tokens, which carry claims and are bearer credentials in practice.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // PEM private key blocks, which may be inlined into a heredoc.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
]

/**
 * Credentials recognised by the syntax that assigns them rather than their own
 * shape, since a password has no distinguishing format of its own.
 *
 * Each pattern captures the name or flag so it can be preserved. `PGPASSWORD` is
 * more useful in the stored text than `[redacted]=[redacted]`, and keeping the
 * name is what lets a future session recognise the lesson without learning the
 * value.
 */
const ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  // Environment assignment or shell export whose name reads as a secret.
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|PAT)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
  // Long-form command flags.
  /(--(?:password|passwd|token|secret|api-?key|access-?key|auth|credential)(?:[= ]))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
  // HTTP authorization headers in any casing, quoted or bare.
  /(\bauthorization\s*:\s*(?:bearer|basic|token)\s+)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/gi,
  // Credentials embedded in a URL's userinfo component.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
]

/**
 * Minimum length at which an unrecognised token is treated as possibly secret.
 *
 * Set at 24 because shorter mixed-case identifiers are overwhelmingly ordinary —
 * a camelCase symbol, a short branch name, a Docker image tag — while credentials
 * are almost always longer.
 */
const RESIDUAL_MINIMUM_LENGTH = 24

/**
 * An unrecognised token long and varied enough that it may be a credential.
 *
 * Requiring all three of lowercase, uppercase and a digit is what keeps this from
 * firing on the things that actually appear in commands: a 40-character git SHA is
 * lowercase hexadecimal and does not match, nor does a lowercase file path, nor a
 * SCREAMING_SNAKE_CASE constant. A base64 blob does match, and is refused, which is
 * the intended trade.
 */
const RESIDUAL_PATTERN = new RegExp(
  `[A-Za-z0-9+/=_-]{${String(RESIDUAL_MINIMUM_LENGTH)},}`,
  'g',
)

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
export function redact(text: string): string {
  let result = text
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, REDACTED)
  }
  for (const pattern of ASSIGNMENT_PATTERNS) {
    result = result.replace(pattern, (_match, prefix: string, suffix?: string) => {
      // The URL pattern captures a trailing `@` that has to survive; the others
      // capture only a prefix and pass `undefined` here.
      const tail = typeof suffix === 'string' ? suffix : ''
      // An environment assignment captures a bare name, so the `=` it lost has to
      // be restored. A flag or header capture already includes its separator.
      const joiner = /[=: ]$/.test(prefix) ? '' : '='
      return `${prefix}${joiner}${REDACTED}${tail}`
    })
  }
  return result
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
export function hasResidualSecret(text: string): boolean {
  const withoutMarkers = text.split(REDACTED).join(' ')
  const matches = withoutMarkers.match(RESIDUAL_PATTERN)
  if (matches === null) return false
  return matches.some(
    (token) => /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token),
  )
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
export function safeForStorage(text: string): string | undefined {
  const redacted = redact(text)
  if (hasResidualSecret(redacted)) return undefined
  return redacted
}
