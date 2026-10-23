import { describe, expect, it } from 'vitest';
import { checkToken, findUnverifiableClaims } from '../src/modules/email/grounding.js';
import { PAIN_POINT_MAP } from '../src/modules/email/painPoints.js';
import { buildOutreachEmail } from '../src/modules/email/template.js';

const signal = (overrides = {}) => ({
  id: 1,
  pain_point: 'stockouts',
  summary_short: 'new Austin store',
  sentence: 'that Northwind Apparel opened a new store in Austin in March',
  source_url: 'https://news.example/northwind-austin',
  source_excerpt: 'Northwind Apparel opened a new store in Austin in March, its fourth in Texas.',
  ...overrides,
});
const base = {
  lead: { id: 7, first_name: 'Dana' },
  company: { name: 'Northwind Apparel', segment: 'DTC brand' },
  campaign: { subject_variant: 1, sender_name: 'Priya', proposed_time_window: null },
};

describe('grounding check', () => {
  it('blocks numbers and superlatives that the cited source does not contain', () => {
    expect(findUnverifiableClaims('sales grew 40% last year', 'sales grew strongly')).toHaveLength(1);
    expect(findUnverifiableClaims('sales grew 40% last year', 'Sales grew 40% in 2025')).toHaveLength(0);
    expect(findUnverifiableClaims('the fastest-growing label', 'a growing label')[0]?.rule).toBe(
      'unverified_superlative',
    );
  });

  it('does not let product copy carry any hard claim', () => {
    const issues = checkToken({
      token: 'value_prop_for_pain_point',
      value: 'cut markdowns by 30%',
      provenance: { kind: 'product_copy', ref: 'x' },
    });
    expect(issues[0]?.rule).toBe('unverified_number');
  });

  it('accepts all of our own pain-point copy (it must carry no hard claims)', () => {
    for (const [key, copy] of Object.entries(PAIN_POINT_MAP)) {
      for (const [field, value] of Object.entries(copy)) {
        expect(
          checkToken({ token: field, value, provenance: { kind: 'product_copy', ref: `${key}.${field}` } }),
        ).toEqual([]);
      }
    }
  });

  it('rejects signals without a source URL and values with markup', () => {
    expect(
      checkToken({
        token: 't',
        value: 'ok',
        provenance: { kind: 'signal', ref: 's', sourceUrl: '', evidence: 'ok' },
      })[0]?.rule,
    ).toBe('missing_source_url');
    expect(checkToken({ token: 't', value: '<b>hi</b>', provenance: { kind: 'lead_field', ref: 'f' } })[0]?.rule).toBe(
      'unsafe_content',
    );
  });
});

describe('buildOutreachEmail (Appendix A)', () => {
  it('fills every sentence from grounded data and keeps the locked skeleton', () => {
    const email = buildOutreachEmail({ ...base, signals: [signal()] });
    expect(email.blocked).toBe(false);
    expect(email.subject).toBe('Northwind Apparel’s new Austin store - quick question');
    expect(email.paragraphs).toEqual([
      'Hi Dana,',
      'I noticed that Northwind Apparel opened a new store in Austin in March.',
      'At StyleSense AI, we help apparel and fashion DTC brand teams allocate inventory across stores and channels to where demand actually is.',
      'Given Northwind Apparel’s new Austin store, smarter allocation could keep fast-moving styles in stock where customers are looking for them.',
      'Would you be open to a 15-minute call to see if it’s a fit?',
    ]);
    expect(email.signOff).toEqual(['Best,', 'Priya', 'StyleSense AI']);
    expect(email.tokens.find((t) => t.token === 'observed_signal_sentence')?.sourceUrl).toBe(
      'https://news.example/northwind-austin',
    );
  });

  it('drops a signal with an unverifiable claim, logs it, and falls back to a grounded one', () => {
    const bad = signal({
      id: 2,
      sentence: 'that Northwind Apparel grew online sales 300% this year',
      summary_short: 'online growth',
    });
    const email = buildOutreachEmail({ ...base, signals: [bad, signal()] });
    expect(email.log.some((l) => l.rule === 'unverified_number' && l.action === 'dropped_sentence')).toBe(true);
    expect(email.paragraphs[1]).toContain('Austin');
    expect(email.paragraphs.join(' ')).not.toContain('300%');
  });

  it('blocks the send when no grounded signal exists instead of inventing one', () => {
    const email = buildOutreachEmail({ ...base, signals: [] });
    expect(email.blocked).toBe(true);
    expect(email.subject).toBeNull();
    expect(email.log.some((l) => l.action === 'blocked_send')).toBe(true);
  });

  it('omits the optional time window cleanly and uses it when provided', () => {
    const withWindow = buildOutreachEmail({
      ...base,
      signals: [signal()],
      campaign: { ...base.campaign, proposed_time_window: 'next Tuesday or Wednesday' },
    });
    expect(withWindow.paragraphs.at(-1)).toBe(
      'Would you be open to a 15-minute call next Tuesday or Wednesday to see if it’s a fit?',
    );
  });

  it('infers the pitched capability from the signal kind and labels it as inferred', () => {
    const email = buildOutreachEmail({
      ...base,
      signals: [signal({ kind: 'leadership', pain_point: null, sentence: 'I noticed that Northwind named a new CMO' })],
    });
    expect(email.blocked).toBe(false);
    expect(email.paragraphs[1]).toBe('I noticed that Northwind named a new CMO.');
    expect(email.paragraphs[2]).toContain('forecast demand');
    expect(email.tokens.find((t) => t.token === 'value_prop_for_pain_point').source).toContain('inferred from "leadership"');
  });

  it('drops the value-prop sentence when the company segment is unknown', () => {
    const email = buildOutreachEmail({ ...base, company: { ...base.company, segment: null }, signals: [signal()] });
    expect(email.paragraphs.some((p) => p.startsWith('At StyleSense AI'))).toBe(false);
    expect(email.log.some((l) => l.token === 'company_segment')).toBe(true);
  });
});
