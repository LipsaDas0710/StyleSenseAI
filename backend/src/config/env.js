import 'dotenv/config';
import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5000'),
  // Optional here so DB-free scripts (reply eval) can load config; db/pool.js enforces it.
  DATABASE_URL: optional,
  TEST_DATABASE_URL: optional,

  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  EMAIL_FROM: z.string().default('StyleSense AI <onboarding@resend.dev>'),
  EMAIL_TEST_RECIPIENT: optional,
  RESEND_API_KEY: optional,

  LLM_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  LLM_API_KEY: optional,
  LLM_MODEL: z.string().default('openai/gpt-oss-120b'),
  // Only for reasoning models that accept it (e.g. gpt-oss on Groq); lower = fewer tokens.
  LLM_REASONING_EFFORT: optional.pipe(z.enum(['low', 'medium', 'high']).optional()),
  SEARCH_API_KEY: optional,
});

function load() {
  const raw = { ...process.env };
  // Tests run against a dedicated database so they can truncate tables safely.
  if (process.env.VITEST) {
    raw.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
