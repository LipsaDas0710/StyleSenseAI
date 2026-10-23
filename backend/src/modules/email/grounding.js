/**
 * The grounding check. A token value may only be used if
 *   1. it comes from an allowed provenance (a stored lead/company/campaign field, a stored company
 *      signal that carries a source URL, or StyleSense's own fixed product copy), and
 *   2. every "hard claim" inside it - numbers, percentages, money, superlatives - also appears in that
 *      provenance's evidence text (the verbatim source excerpt stored with the signal).
 * Anything else is an unverifiable claim and is blocked.
 */

const SUPERLATIVES = [
  'largest',
  'biggest',
  'fastest',
  'fastest-growing',
  'leading',
  'best',
  'record',
  'top',
  '#1',
  'number one',
  'first-ever',
  'most popular',
  'world-class',
  'guaranteed',
  'unprecedented',
];

const NUMBER_CLAIM = /(?:[$£€₹]\s?)?\d[\d,.]*\s?(?:%|percent|x\b|k\b|m\b|bn\b|million|billion)?/gi;

const normalize = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
const digitsOf = (s) => s.replace(/[^\d.]/g, '').replace(/\.$/, '');

/** Numbers and superlatives in `text` that are not supported by `evidence`. */
export function findUnverifiableClaims(text, evidence) {
  const issues = [];
  const ev = normalize(evidence);
  const evidenceNumbers = new Set((ev.match(NUMBER_CLAIM) ?? []).map(digitsOf));

  for (const claim of text.match(NUMBER_CLAIM) ?? []) {
    if (!evidenceNumbers.has(digitsOf(claim))) {
      issues.push({ rule: 'unverified_number', detail: `"${claim.trim()}" does not appear in the cited source` });
    }
  }
  const t = normalize(text);
  for (const word of SUPERLATIVES) {
    const pattern = new RegExp(`(^|[^a-z#])${word.replace(/[#-]/g, '\\$&')}([^a-z]|$)`);
    if (pattern.test(t) && !pattern.test(ev)) {
      issues.push({ rule: 'unverified_superlative', detail: `"${word}" is not supported by the cited source` });
    }
  }
  return issues;
}

/** Returns the list of problems with a candidate; an empty list means it is safe to use. */
export function checkToken(candidate) {
  const { token, provenance } = candidate;
  const value = candidate.value?.trim() ?? '';
  const issue = (rule, detail) => ({ token, value: value || null, rule, detail });

  if (!value) return [issue('missing_value', `no stored value for ${provenance.ref}`)];
  if (/[{}<>]|https?:\/\/|[\r\n]/.test(value) || value.length > 300) {
    return [issue('unsafe_content', 'value contains markup, URLs, line breaks or is too long')];
  }
  if (provenance.kind === 'signal' && !/^https?:\/\//.test(provenance.sourceUrl)) {
    return [issue('missing_source_url', `signal ${provenance.ref} has no source URL`)];
  }
  // Stored fields are facts by definition; signal text must be backed by its excerpt; product copy has no
  // external evidence, so it may not contain any hard claims at all.
  const evidence = provenance.kind === 'signal' ? provenance.evidence : provenance.kind === 'product_copy' ? '' : value;
  return findUnverifiableClaims(value, evidence).map((i) => issue(i.rule, i.detail));
}
