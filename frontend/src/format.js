export const STATUSES = ['new', 'sent', 'opened', 'replied', 'suppressed'];

export const formatDate = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const fullName = (lead) => [lead.first_name, lead.last_name].filter(Boolean).join(' ');

export const INTENT_LABELS = {
  interested: 'Interested',
  needs_info: 'Needs info',
  not_now: 'Not now',
  wrong_person: 'Wrong person',
  unsubscribe: 'Unsubscribe',
};
