/**
 * Reports reply-classification accuracy against the hand-labelled set.
 * Uses the LLM classifier if LLM_API_KEY is set, otherwise the keyword classifier.
 *   npm run eval            (configured classifier)
 *   npm run eval -- keyword (force keyword rules)
 */
import { readFile } from 'node:fs/promises';
import { classifyReply, keywordClassify } from '../src/modules/ai/classifier.js';
import { getLlm } from '../src/modules/ai/llm.js';

const examples = JSON.parse(await readFile(new URL('./labelled-replies.json', import.meta.url), 'utf8'));
const forceKeyword = process.argv.includes('keyword');
const llm = forceKeyword ? null : getLlm();
console.log(`Classifier: ${llm ? `LLM (${llm.model})` : 'keyword rules'}   Examples: ${examples.length}\n`);

let correct = 0;
const confusion = new Map();
for (const ex of examples) {
  const result = llm ? await classifyReply(ex.text, llm) : keywordClassify(ex.text);
  const ok = result.intent === ex.label;
  if (ok) correct++;
  confusion.set(`${ex.label} -> ${result.intent}`, (confusion.get(`${ex.label} -> ${result.intent}`) ?? 0) + 1);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  #${ex.id}  expected=${ex.label.padEnd(12)} got=${result.intent.padEnd(12)} ${ex.text.slice(0, 60)}...`,
  );
}

const accuracy = (correct / examples.length) * 100;
console.log(`\nAccuracy: ${correct}/${examples.length} = ${accuracy.toFixed(1)}%`);
const misses = [...confusion].filter(([k]) => k.split(' -> ')[0] !== k.split(' -> ')[1]);
if (misses.length) console.log('Misclassifications:', Object.fromEntries(misses));
