/**
 * Vercel AI Gateway smoke test.
 *
 * Reads AI_GATEWAY_API_KEY from the environment — put it in .env.local (gitignored) and run with
 * `node --env-file-if-exists=.env.local index.ts`. The key is never hard-coded here and must not be.
 */
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.5',
  prompt: 'Invent a new holiday and describe its traditions.',
});

console.log(text);
