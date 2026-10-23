import { isIP } from 'node:net';
import { env } from '../../config/env.js';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web. Returns up to 5 results with title, url and a snippet.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        'Fetch a public web page and return its visible text (truncated). You must fetch every page you will cite.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
        required: ['url'],
      },
    },
  },
];

/** https://docs.tavily.com/documentation/api-reference/endpoint/search */
export async function webSearch(query, { excludeDomains = [] } = {}) {
  if (!env.SEARCH_API_KEY) throw new Error('SEARCH_API_KEY is not set');
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SEARCH_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: 5, search_depth: 'basic', exclude_domains: excludeDomains.slice(0, 50) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`search failed with HTTP ${response.status}`);
  const body = await response.json();
  return (body.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? '', url: r.url, snippet: (r.content ?? '').slice(0, 250) }));
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i;
// Full text is kept server-side for verification; only relevant excerpts are ever sent to the LLM.
const MAX_PAGE_CHARS = 40_000;

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The parts of `text` around any keyword hit (merged windows), capped at maxChars. Keeps prompts within
 * free-tier token limits while preserving the sentences that name people and signals.
 */
export function relevantExcerpt(text, keywords, maxChars) {
  const lower = text.toLowerCase();
  const windows = [];
  for (const keyword of keywords) {
    for (let i = lower.indexOf(keyword); i !== -1; i = lower.indexOf(keyword, i + keyword.length)) {
      windows.push([Math.max(0, i - 250), Math.min(text.length, i + 350)]);
    }
  }
  if (!windows.length) return text.slice(0, Math.floor(maxChars / 2));
  windows.sort((a, b) => a[0] - b[0]);
  const merged = [windows[0]];
  for (const [start, end] of windows.slice(1)) {
    const last = merged.at(-1);
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.map(([s, e]) => text.slice(s, e)).join(' … ').slice(0, maxChars);
}

/** Fetches a public page as plain text. Refuses non-http(s) and private-network hosts (SSRF guard). */
export async function fetchPage(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http(s) URLs are allowed');
  if (PRIVATE_HOST.test(url.hostname) || (isIP(url.hostname) && PRIVATE_HOST.test(url.hostname))) {
    throw new Error('private network addresses are not allowed');
  }
  const response = await fetch(url, {
    // Many press/IR sites reject non-browser user agents with 403.
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      Accept: 'text/html,text/plain',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain/.test(type)) throw new Error(`unsupported content type ${type}`);
  const body = (await response.text()).slice(0, 1_000_000);
  return htmlToText(body).slice(0, MAX_PAGE_CHARS);
}
