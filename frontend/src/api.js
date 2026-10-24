export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Backend origin in production (e.g. https://stylesense-api.onrender.com). Empty in development, where the
// Vite dev server proxies /api, /t and /u to localhost:5000.
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** fetch wrapper that turns the backend's { error: { code, message, details } } shape into an ApiError. */
async function request(method, path, body) {
  let response;
  try {
    response = await fetch(API_URL + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the API at ${API_URL || 'localhost:5000'} - is the backend running?`);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = data?.error;
    throw new ApiError(response.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${response.status})`, err?.details);
  }
  return data;
}

const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

export const api = {
  health: () => request('GET', '/api/health'),

  listLeads: (params) => request('GET', `/api/leads${qs(params)}`),
  getLead: (id) => request('GET', `/api/leads/${id}`),
  createLead: (body) => request('POST', '/api/leads', body),
  updateLead: (id, body) => request('PATCH', `/api/leads/${id}`, body),
  leadEvents: (id) => request('GET', `/api/leads/${id}/events?limit=50`),
  scoreHistory: (id) => request('GET', `/api/leads/${id}/score-history?limit=50`),

  listCampaigns: () => request('GET', '/api/campaigns?limit=100'),
  getCampaign: (id) => request('GET', `/api/campaigns/${id}`),
  createCampaign: (body) => request('POST', '/api/campaigns', body),
  updateCampaign: (id, body) => request('PATCH', `/api/campaigns/${id}`, body),
  addLeadsToCampaign: (id, leadIds) => request('POST', `/api/campaigns/${id}/leads`, { leadIds }),
  previewEmail: (campaignId, leadId) => request('GET', `/api/campaigns/${campaignId}/leads/${leadId}/preview`),
  sendCampaign: (id, leadIds) => request('POST', `/api/campaigns/${id}/send`, leadIds ? { leadIds } : {}),

  simulateReply: (leadId, text) => request('POST', `/api/leads/${leadId}/replies`, { text }),
  approveDraft: (id, body) => request('POST', `/api/reply-drafts/${id}/approve`, body ? { body } : {}),
  discardDraft: (id) => request('POST', `/api/reply-drafts/${id}/discard`, {}),

  runDiscovery: (icp) => request('POST', '/api/discovery/runs', icp),
  listDiscoveryRuns: () => request('GET', '/api/discovery/runs?limit=10'),
};
