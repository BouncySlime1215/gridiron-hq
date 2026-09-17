/**
 * TypeSafe AI "Jev" evaluation model via Vercel AI Gateway.
 *
 * Jev answers typed questions about a piece of state and returns choices, scores and boolean
 * PROBABILITIES — several questions per request, at $0.04 per 1M input tokens. That shape is a
 * direct fit for the coach-speak problem: take a press-conference transcript and turn it into
 * availability signals that can be joined onto line movement by timestamp.
 *
 * The probabilities matter more than the labels. A coach saying "we'll see how he looks Friday"
 * is not a 0 or a 1, and a feature that records 0.55 carries information a hard label throws away.
 *
 * Run: node --env-file-if-exists=.env.local jev.ts
 */
import { experimental_evaluate as evaluate } from 'ai';

// A representative answer — hedged, which is the interesting case.
const transcript = `
Reporter: Any update on the quarterback's shoulder?
Coach: He got some work in today, threw a little on the side. We'll see how he responds
tomorrow. I'm not going to put a label on it yet. If he's ready, he's ready.
Reporter: And the left tackle?
Coach: He's good. He'll be out there Sunday.
`;

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: transcript,
  questions: {
    qb_plays: {
      type: 'boolean',
      instructions: 'Is the coach indicating the quarterback WILL play in the next game?',
    },
    qb_hedged: {
      type: 'boolean',
      instructions: 'Is the answer about the quarterback evasive or non-committal, rather than a clear yes or no?',
    },
    lt_plays: {
      type: 'boolean',
      instructions: 'Is the coach indicating the left tackle WILL play in the next game?',
    },
    injury_discussed: {
      type: 'boolean',
      instructions: 'Does the coach discuss a specific player injury?',
    },
  },
});

console.log(JSON.stringify(result, null, 2));
