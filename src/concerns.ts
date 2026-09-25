import { objectWithKeys } from './validation.js';
import { shortText } from './acceptance.js';

export const CHANGE_CATEGORIES = ['objective', 'integrations', 'sensitive-data', 'permissions'] as const;
export type Concern = { category: typeof CHANGE_CATEGORIES[number]; evidence: string; impact: string };
/** Largest serialized concerns payload the change-request transport decodes. */
export const CONCERNS_TRANSPORT_MAX_BYTES = 16000;

/**
 * Tool bridges do not always deliver the concerns argument as the array the schema declares: some
 * serialize it as JSON text, and a model asked for one concern often sends the bare object. Both
 * are unambiguous, so they are normalized here instead of blocking the request; the content itself
 * is still validated strictly by concerns().
 */
export function decodeConcerns(value: unknown): Concern[] {
  let decoded = value;
  if (typeof decoded === 'string') {
    const text = decoded.trim();
    if (!text) return [];
    if (Buffer.byteLength(text, 'utf8') > CONCERNS_TRANSPORT_MAX_BYTES) throw new Error(`concerns text exceeds ${CONCERNS_TRANSPORT_MAX_BYTES} bytes; nothing was recorded.`);
    try { decoded = JSON.parse(text); }
    catch { throw new Error('concerns was sent as a string but is not valid JSON; nothing was recorded.'); }
  }
  if (decoded === null) return [];
  if (typeof decoded === 'object' && !Array.isArray(decoded)) decoded = [decoded];
  return concerns(decoded);
}

export function concerns(value: unknown): Concern[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Advisory concerns must decode to an array; a raw string is not accepted here.');
  if (value.length > 8) throw new Error('Supply at most eight advisory concerns.');
  return value.map(value => {
    const item = objectWithKeys(value, 'concern', ['category', 'evidence', 'impact']);
    if (!CHANGE_CATEGORIES.includes(item.category as Concern['category'])) throw new Error('Unknown material-change category.');
    return { category: item.category as Concern['category'], evidence: shortText(item.evidence, 'concern evidence'), impact: shortText(item.impact, 'concern impact') };
  });
}
