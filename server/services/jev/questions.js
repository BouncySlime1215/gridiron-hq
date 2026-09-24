/**
 * JEV-01a question registry: one typed schema and version per question type.
 *
 * Each type is asked in two phrasings ("arms" a and b) so the stage can check
 * Jev against itself; a spread over 0.25 between arms is stored as its own
 * field. Bump `version` whenever a phrasing or its criteria change, so the
 * JEV-01b grader never pools answers to different questions.
 *
 * `interpret` turns the typed answer into { p, action, ... }. Actions are
 * recommendations for the shadow lane only (weight 0): nothing serves them
 * until the grader earns Jev a weight.
 *
 * A type may carry an `askable(subject)` gate; the stage skips an ask the gate
 * refuses and reports it `not_asked` with the reason (startsit_tiebreak is only
 * a tiebreak inside 1 paired SE of the sim margin).
 */

const bool = (instructions, t, f) => ({ type: 'boolean', instructions, criteria: { true: t, false: f } });

function boolAnswer(answers, id) {
  const a = answers?.[id];
  if (!a || a.type !== 'boolean' || !Number.isFinite(a.probability)) {
    throw new Error(`Jev returned a missing answer for "${id}"`);
  }
  return Math.min(1, Math.max(0, a.probability));
}

function choiceAnswer(answers, id) {
  const a = answers?.[id];
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') {
    throw new Error(`Jev returned a missing answer for "${id}"`);
  }
  return a;
}

/** #263's PITCH arms (OFFER-01 pitch framings), in its order. */
export const PITCH_ARMS = Object.freeze(['need_first', 'fairness_first', 'urgency_first', 'face_safe_short']);
const START_OPTIONS = Object.freeze(['A', 'B']);

/** A choice answer whose choice must be one of `keys`; returns p, the choice and its probability vector. */
function choiceOver(answers, id, keys) {
  const a = choiceAnswer(answers, id);
  if (!keys.includes(a.choice)) throw new Error(`Jev's "${id}" answer "${a.choice}" is not one of ${keys.join('/')}`);
  const probs = a.probabilities ?? { [a.choice]: 1 };
  return { p: probs[a.choice] ?? null, choice: a.choice, probabilities: probs, vector: keys.map(k => probs[k] ?? 0) };
}

export const QUESTION_TYPES = Object.freeze({
  plays_sunday: {
    version: 1,
    subject: 'player',
    build: (s, arm) => ({
      plays: arm === 'a'
        ? bool(`Will ${s.label} be active and take at least one offensive snap in this week's game?`,
          'He is active and plays at least one snap.', 'He is inactive, ruled out, or does not play a snap.')
        : bool(`Using only the state above, is ${s.label} going to play in his team's game this week?`,
          'Plays in the game.', 'Does not play in the game.'),
    }),
    interpret(answers) {
      const p = boolAnswer(answers, 'plays');
      return { p, vector: [p] };
    },
    recommend: ({ p }) => (p < 0.35 ? 'bench_or_replace' : p < 0.65 ? 'monitor_pre_lock' : 'no_change'),
  },

  role_change: {
    version: 1,
    subject: 'player',
    build: (s, arm) => ({
      role: {
        type: 'choice',
        instructions: arm === 'a'
          ? `Given the news and usage in the state, how does ${s.label}'s role this week compare with his last three weeks?`
          : `Read the reports above. Is ${s.label}'s share of his team's snaps and targets or carries about to shrink, hold, or grow?`,
        criteria: {
          down: 'Smaller role: fewer snaps, targets or carries than recently.',
          same: 'About the same role as recently.',
          up: 'Bigger role: more snaps, targets or carries than recently.',
        },
      },
    }),
    interpret(answers) {
      const a = choiceAnswer(answers, 'role');
      const probs = a.probabilities ?? { [a.choice]: 1 };
      const vector = ['down', 'same', 'up'].map(k => probs[k] ?? 0);
      return { p: probs[a.choice] ?? null, choice: a.choice, probabilities: probs, vector };
    },
    recommend: ({ choice }) => ({ down: 'review_role_down', same: 'no_change', up: 'review_role_up' }[choice] ?? 'no_change'),
  },

  p_accept: {
    version: 1,
    subject: 'offer',
    build: (s, arm) => ({
      accepts: arm === 'a'
        ? bool(`Will the receiving manager accept ${s.label} as proposed?`,
          'The receiving manager accepts it.', 'The receiving manager declines, counters, or lets it expire.')
        : bool(`Judging from how this manager has behaved in the state above, does ${s.label} get accepted without changes?`,
          'Accepted as sent.', 'Not accepted as sent.'),
    }),
    interpret(answers) {
      const p = boolAnswer(answers, 'accepts');
      return { p, vector: [p] };
    },
    recommend: ({ p }) => (p >= 0.5 ? 'send' : p >= 0.2 ? 'revise_offer' : 'drop_offer'),
  },

  sim_contradiction: {
    version: 1,
    subject: 'player',
    build: (s, arm) => {
      const links = s.links?.length ? s.links : ['sim', 'news'];
      return {
        contradiction: arm === 'a'
          ? bool(`Does anything in the state contradict the simulator's range for ${s.label} this week?`,
            'Some fact in the state contradicts the simulated range.', 'The simulated range is consistent with the state.')
          : bool(`Check ${s.label}'s simulated numbers against the news and usage. Is there a conflict a careful analyst would flag?`,
            'There is a conflict worth flagging.', 'No conflict.'),
        link: {
          type: 'choice',
          instructions: `If there is a contradiction for ${s.label}, which input is most likely wrong?`,
          criteria: Object.fromEntries(links.map(l => [l, `The input "${l}" is the one out of line.`])),
        },
      };
    },
    interpret(answers) {
      const p = boolAnswer(answers, 'contradiction');
      const link = choiceAnswer(answers, 'link').choice;
      return { p, link, vector: [p] };
    },
    recommend: ({ p }) => (p >= 0.5 ? 'flag_for_review' : 'no_change'),
  },

  pitch_framing: {
    version: 1,
    subject: 'offer',
    build: (s, arm) => ({
      pitch: {
        type: 'choice',
        instructions: arm === 'a'
          ? `Which framing gives ${s.label} the best chance of being accepted by the receiving manager?`
          : `Based on how this manager has reacted to offers in the state above, how should the message for ${s.label} open?`,
        criteria: {
          need_first: 'Lead with what the receiving manager needs: the hole in his roster this fills.',
          fairness_first: 'Lead with why the deal is fair value for both sides.',
          urgency_first: 'Lead with timing: why the deal is worth doing now.',
          face_safe_short: 'A short, low-pressure note that lets him decline without losing face.',
        },
      },
    }),
    interpret: answers => choiceOver(answers, 'pitch', PITCH_ARMS),
    recommend: ({ choice }) => `pitch_${choice}`,
  },

  startsit_tiebreak: {
    version: 1,
    subject: 'league_team_week',
    /** Only a tiebreak: asked when |sim margin| is under 1 paired SE, never to overrule a clear sim call. */
    askable(s) {
      if (!Number.isFinite(s?.sim_margin)) return { ok: false, reason: 'no_sim_margin' };
      if (!(Number.isFinite(s?.paired_se) && s.paired_se > 0)) return { ok: false, reason: 'no_paired_se' };
      return Math.abs(s.sim_margin) < s.paired_se ? { ok: true } : { ok: false, reason: 'sim_margin_over_1_paired_se' };
    },
    build: (s, arm) => {
      if (!s.options?.A || !s.options?.B) throw new Error(`Jev question startsit_tiebreak needs options A and B for ${s.label}`);
      return {
        start: {
          type: 'choice',
          instructions: arm === 'a'
            ? `The simulator calls ${s.label} a coin flip. Who scores more this week?`
            : `Using only the state above, which of the two players should start in ${s.label} this week?`,
          criteria: { A: `Start ${s.options.A}.`, B: `Start ${s.options.B}.` },
        },
      };
    },
    interpret: answers => choiceOver(answers, 'start', START_OPTIONS),
    recommend: ({ choice }) => `start_${choice}`,
  },
});

export const ARMS = Object.freeze(['a', 'b']);

function typeOf(qtype) {
  const t = QUESTION_TYPES[qtype];
  if (!t) throw new Error(`unknown Jev question type "${qtype}"`);
  return t;
}

/** The `questions` object the gateway sends to Jev for one type, arm and subject. */
export function buildQuestions(qtype, arm, subject) {
  if (!ARMS.includes(arm)) throw new Error(`unknown Jev arm "${arm}"`);
  if (!subject?.label) throw new Error(`Jev question ${qtype} needs a subject label`);
  return typeOf(qtype).build(subject, arm);
}

/** Typed answers -> { p, action, ... }. Throws on a missing or mistyped answer. */
export function interpret(qtype, answers) {
  const t = typeOf(qtype);
  const out = t.interpret(answers);
  return { ...out, action: t.recommend(out) };
}

/** { ok: true } or { ok: false, reason }: whether this ask may go to Jev at all. */
export function askable(qtype, subject) {
  const t = typeOf(qtype);
  return t.askable ? t.askable(subject) : { ok: true };
}

export function recommend(qtype, summary) {
  return typeOf(qtype).recommend(summary);
}
