/**
 * The chat half of an MDD question. OpenCode's question form cannot scroll: in the TUI a long
 * question is cut, and in the desktop app the options get only the height the question leaves. So
 * the form asks one short question and the context it needs travels separately, as Markdown the
 * coordinator writes in the chat, as it is, right before asking. Display text only: what a question
 * authorizes is still its exact envelope, labels and nonce.
 */
export const WHY_PREFIX = 'Por qué importa: ';

/** The user's own text, kept line for line as a Markdown quote. */
export function quoted(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim() ? `> ${line}` : '>').join('\n');
}

export function bullets(items: readonly string[]): string {
  return items.map(item => `- ${item}`).join('\n');
}

/** A Markdown section: bold title, then its body on the next lines. */
export function section(title: string, body: string): string {
  return `**${title}**\n${body}`;
}

/**
 * Why each question matters, for the questions that say it. Each entry names the question it
 * belongs to, because one form may ask several. Undefined when no question carries a why.
 */
export function whyBrief(items: readonly { label: string; question: string; why?: string | undefined }[]): string | undefined {
  const blocks = items.filter(item => item.why?.trim()).map(item => `**${item.label}:** ${item.question}\n\n${WHY_PREFIX}${item.why}`);
  return blocks.length ? blocks.join('\n\n') : undefined;
}
