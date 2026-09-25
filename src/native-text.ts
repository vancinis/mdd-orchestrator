/**
 * Pure helpers for reading what a native user actually typed. OpenCode adds its own text parts
 * to a user message — for a file mention, an agent mention, or other host-synthesized content —
 * and those parts are never something the user wrote. Excluding them from the candidate text is
 * what keeps an ordinary mention from voiding the whole message; keeping every remaining part
 * bound to its own sender is what keeps a forged or misattributed part from being read as theirs.
 */
export type NativeTextPart = Record<string, unknown> & { type?: unknown; synthetic?: unknown; ignored?: unknown; sessionID?: unknown; messageID?: unknown; text?: unknown };

/**
 * Joins the parts of a user message that are actually authored text: not synthetic, not ignored,
 * and owned by the exact session and message they claim. A message with no authored text left
 * after excluding host-added parts is not a candidate at all, so `undefined` is returned rather
 * than an empty string, which would otherwise match an equally empty requirement.
 */
export function authoredNativeText(parts: readonly NativeTextPart[], sessionID: string, messageID: string): string | undefined {
  const authored = parts.filter(part => part.type === 'text' && part.synthetic !== true && part.ignored !== true);
  if (!authored.length) return undefined;
  if (authored.some(part => part.sessionID !== sessionID || part.messageID !== messageID || typeof part.text !== 'string')) {
    throw new Error('Native message text ownership does not match its recorded sender.');
  }
  return authored.map(part => part.text as string).join('\n');
}

/**
 * The one normalization the exact-match comparison performs: line endings are folded to `\n` and
 * the outer edges are trimmed, because those are transport artifacts, not something the user
 * wrote. Case, inner whitespace and compatibility forms are left untouched on purpose — folding
 * them turns "exactly what the user said" into an approximate match, which is the bypass this
 * comparison exists to refuse.
 */
export function canonicalNativeText(value: string): string {
  return value.replace(/\r\n|\r/g, '\n').trim();
}

/** The index of the first character at which two strings diverge, or the length of the shorter one. */
export function firstDivergence(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}
