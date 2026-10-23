import { describe, expect, it } from 'vitest';
import { computeScore, describeChange } from '../src/modules/scoring/scoring.js';

const strongFit = {
  title: 'Head of Merchandising',
  industry: 'Apparel & Fashion',
  segment: 'DTC brand',
  region: 'United States',
  sizeBand: '201-1000',
};
const weakFit = {
  title: 'Software Engineer',
  industry: 'Fintech',
  segment: null,
  region: 'Antarctica',
  sizeBand: null,
};
const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
const ev = (type, minutes = 0, intent) => ({
  type,
  occurredAt: at(minutes),
  intent,
});

describe('computeScore', () => {
  it('ranks an ICP-matching merchandising lead well above an unrelated one', () => {
    const strong = computeScore(strongFit, []);
    const weak = computeScore(weakFit, []);
    expect(strong.fit).toBe(100);
    expect(weak.fit).toBe(0);
    expect(strong.total).toBe(60);
    expect(weak.total).toBe(0);
    expect(strong.status).toBe('new');
  });

  it('adds engagement for an open and marks the lead opened', () => {
    const sent = computeScore(strongFit, [ev('delivered')]);
    const opened = computeScore(strongFit, [ev('delivered'), ev('opened', 5)]);
    expect(sent.status).toBe('sent');
    expect(opened.status).toBe('opened');
    expect(opened.engagement - sent.engagement).toBe(30);
    expect(opened.total).toBeGreaterThan(sent.total);
  });

  it('caps repeated opens so pixel reloads cannot inflate the score', () => {
    const opens = Array.from({ length: 50 }, (_, i) => ev('opened', i + 1));
    const many = computeScore(strongFit, [ev('delivered'), ...opens]);
    const three = computeScore(strongFit, [ev('delivered'), ...opens.slice(0, 3)]);
    expect(many.engagement).toBe(three.engagement);
    expect(many.engagement).toBe(5 + 30 + 2 * 5);
  });

  it('weights a reply above an open and applies the latest reply intent', () => {
    const base = [ev('delivered'), ev('opened', 1)];
    const opened = computeScore(strongFit, base);
    const interested = computeScore(strongFit, [...base, ev('replied', 2, 'interested')]);
    const notNowThenInterested = computeScore(strongFit, [
      ...base,
      ev('replied', 2, 'not_now'),
      ev('replied', 10, 'interested'),
    ]);
    expect(interested.status).toBe('replied');
    expect(interested.total).toBeGreaterThan(opened.total);
    expect(notNowThenInterested.engagement).toBe(interested.engagement);
  });

  it('keeps every score within 0-100', () => {
    const everything = [
      ev('delivered'),
      ...Array.from({ length: 10 }, (_, i) => ev('opened', i)),
      ev('replied', 20, 'interested'),
    ];
    const max = computeScore(strongFit, everything);
    expect(max.engagement).toBe(100);
    expect(max.total).toBeLessThanOrEqual(100);
    const wrongPerson = computeScore(weakFit, [ev('replied', 1, 'wrong_person')]);
    expect(wrongPerson.engagement).toBe(0);
    expect(wrongPerson.total).toBeGreaterThanOrEqual(0);
  });

  it('suppresses and zeroes the lead on unsubscribe, via link or reply intent', () => {
    const viaLink = computeScore(strongFit, [ev('delivered'), ev('opened', 1), ev('unsubscribed', 2)]);
    const viaReply = computeScore(strongFit, [ev('delivered'), ev('replied', 2, 'unsubscribe')]);
    const viaList = computeScore(strongFit, [ev('delivered')], { suppressed: true });
    for (const result of [viaLink, viaReply, viaList]) {
      expect(result.status).toBe('suppressed');
      expect(result.total).toBe(0);
    }
  });

  it('is deterministic: recomputing from the same history gives the same score', () => {
    const history = [ev('delivered'), ev('opened', 3), ev('replied', 9, 'needs_info')];
    expect(computeScore(strongFit, history)).toEqual(computeScore(strongFit, [...history].reverse()));
  });
});

describe('describeChange', () => {
  it('explains the delta and its trigger', () => {
    const before = computeScore(strongFit, [ev('delivered')]);
    const after = computeScore(strongFit, [ev('delivered'), ev('opened', 1)]);
    expect(describeChange(before, after, 'opened event')).toBe(
      `opened event: ${before.total} -> ${after.total} (+12); engagement 5 -> 35`,
    );
    expect(describeChange(null, before, 'lead created')).toMatch(/^Initial score/);
  });
});
