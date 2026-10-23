// Appendix A pain point -> capability map. This is StyleSense AI's own product copy, so it is the
// only "claim" text outreach may use without a cited source. It deliberately contains no numbers.
export const PAIN_POINT_MAP = {
  overstock: {
    category: 'overstock and markdowns',
    capability: 'AI demand forecasting',
    valueProp: 'forecast demand by style, size and channel so buys track what actually sells',
    hypothesis: 'sharper demand forecasts could reduce how much inventory ends up marked down',
  },
  returns: {
    category: 'size-related returns',
    capability: 'size and fit prediction',
    valueProp: 'predict the right size for each shopper before checkout',
    hypothesis: 'better size and fit recommendations could help bring return rates down',
  },
  slow_trends: {
    category: 'trend lag',
    capability: 'trend intelligence',
    valueProp: 'spot emerging trends early enough to act on them within the season',
    hypothesis: 'earlier trend signals could help your team react within the season rather than after it',
  },
  stockouts: {
    category: 'stockouts',
    capability: 'inventory allocation optimisation',
    valueProp: 'allocate inventory across stores and channels to where demand actually is',
    hypothesis: 'smarter allocation could keep fast-moving styles in stock where customers are looking for them',
  },
};

// Used only when research found a signal but no explicit pain point. It selects which of our capabilities
// to pitch, and the email phrases it as a hypothesis ("could ..."), never as a fact about the company.
export const SIGNAL_KIND_PAIN_POINT = {
  markdowns: 'overstock',
  sustainability: 'overstock', // overproduction initiatives
  hiring: 'overstock', // planning/merchandising hires -> demand forecasting
  leadership: 'overstock', // new merchandising leadership typically revisits buy plans
  stockouts: 'stockouts',
  expansion: 'stockouts', // more stores/channels -> allocation
  returns: 'returns',
  launch: 'slow_trends', // new collections -> trend intelligence
};

/** The pain point for a signal: the researched one, else the documented inference from its kind (or null). */
export function painPointFor(signal) {
  if (!signal) return { key: null, inferred: false };
  if (signal.pain_point) return { key: signal.pain_point, inferred: false };
  const key = SIGNAL_KIND_PAIN_POINT[signal.kind] ?? null;
  return { key, inferred: key !== null };
}
