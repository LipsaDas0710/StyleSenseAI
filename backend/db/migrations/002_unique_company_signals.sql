-- The same researched fact (same company, source and summary) must only be stored once.
DELETE FROM company_signals a
 USING company_signals b
 WHERE a.company_id = b.company_id
   AND a.source_url = b.source_url
   AND lower(a.summary_short) = lower(b.summary_short)
   AND a.id > b.id;

CREATE UNIQUE INDEX company_signals_unique_fact
  ON company_signals (company_id, source_url, lower(summary_short));
