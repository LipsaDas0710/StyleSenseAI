import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';

async function start() {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    // Connection refusals arrive as an AggregateError with an empty message but a code.
    console.error(`Cannot connect to PostgreSQL: ${error.message || error.code || String(error)}`);
    console.error('Check DATABASE_URL in backend/.env and that PostgreSQL is running.');
    process.exit(1);
  }
  createApp().listen(env.PORT, () => {
    console.log(
      `StyleSense AI API on http://localhost:${env.PORT}  (email provider: ${env.EMAIL_PROVIDER}, ` +
        `LLM: ${env.LLM_API_KEY ? env.LLM_MODEL : 'not configured - keyword classifier'})`,
    );
  });
}

void start();
