import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

export class ProviderError extends AppError {
  providerStatus;

  constructor(message, providerStatus) {
    super(502, 'EMAIL_PROVIDER_ERROR', message);
    this.providerStatus = providerStatus;
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Development provider: nothing leaves the machine. Validates like a real provider would. */
export class LogProvider {
  name = 'log';
  async send(email) {
    if (!EMAIL_RE.test(email.to)) throw new ProviderError(`Invalid recipient address: ${email.to}`, 422);
    if (!email.subject.trim()) throw new ProviderError('Subject is required', 422);
    const providerMessageId = `log_${randomUUID()}`;
    console.log(`\n[email:log] ${providerMessageId}\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    return { providerMessageId };
  }
}

/** https://resend.com/docs/api-reference/emails/send-email */
export class ResendProvider {
  name = 'resend';
  apiKey;
  from;

  constructor(apiKey, from) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(email) {
    let response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: email.headers,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ProviderError(`Resend unreachable: ${error.message}`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id) {
      throw new ProviderError(
        `Resend rejected the email (${response.status}): ${body.message ?? 'unknown error'}`,
        response.status,
      );
    }
    return { providerMessageId: body.id };
  }
}

export function getEmailProvider() {
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'RESEND_API_KEY is not set');
    return new ResendProvider(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  return new LogProvider();
}

/**
 * Safety net: outside the log provider, every email goes to EMAIL_TEST_RECIPIENT so no real
 * prospect is ever contacted from this demo.
 */
export function resolveRecipient(provider, leadEmail) {
  if (env.EMAIL_TEST_RECIPIENT) return env.EMAIL_TEST_RECIPIENT;
  if (provider.name === 'log') return leadEmail;
  throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Set EMAIL_TEST_RECIPIENT before sending through a real provider');
}
