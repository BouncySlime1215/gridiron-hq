/** Explicit research replay entry point; does not start the server or scheduler. */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { scorePythonArtifact } from '../server/betting/nfl/forecast/python-artifact.js';

const { values } = parseArgs({ options: {
  request: { type: 'string' }, 'artifact-root': { type: 'string' }, python: { type: 'string' }
} });
if (!values.request) throw new Error('Usage: node scripts/score-nfl-artifact.mjs --request frozen-request.json [--python /path/to/python] [--artifact-root /path/to/artifacts]');
const request = JSON.parse(await readFile(values.request, 'utf8'));
const result = await scorePythonArtifact(request, { artifactRoot: values['artifact-root'], python: values.python });
console.log(JSON.stringify(result, null, 2));
if (!result.available) process.exitCode = 1;
