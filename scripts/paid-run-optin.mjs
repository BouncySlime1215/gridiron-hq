/**
 * The opt-in a script must hold before it is allowed to spend money.
 *
 * A handful of scripts in this repository call the Anthropic API for real, and
 * their headers say so. What none of them had was anything that stopped an
 * accidental invocation: the default command runs, the migrations run, and the
 * bill arrives. The standing rule for R&D work is that nothing is paid, ever,
 * which a deliberate run does not breach and an accidental one does.
 *
 * So the refusal is the default and the opt-in is explicit, in the environment,
 * where the person typing the command has to put it there on purpose.
 *
 * PRESENCE ONLY, NEVER THE VALUE. The verdict below is built from whether the
 * variable is set, and the returned reason names the variable rather than what
 * it holds. This is not fastidiousness: the opt-in sits in the same environment
 * as the API keys, this project has had three key-exposure incidents, and a
 * guard that echoed what it read into a log or an error message would be a
 * fourth. `trim()` is used to decide that an empty or all-whitespace setting is
 * not an opt-in; nothing else looks at the contents.
 */

/** The variable a caller sets to accept the charge. */
export const PAID_RUN_OPT_IN = 'GRIDIRON_ALLOW_PAID_RUN';

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} variable
 * @returns {{ allowed: boolean, reason: string }}
 */
export function paidRunOptIn(env = process.env, variable = PAID_RUN_OPT_IN) {
  const raw = env[variable];
  const present = typeof raw === 'string' && raw.trim() !== '';
  return present
    ? { allowed: true, reason: `${variable} is set` }
    : {
      allowed: false,
      reason: `refusing to run: this makes real, billed Anthropic API calls. `
        + `Set ${variable} to any non-empty value to accept the charge.`
    };
}

/**
 * Exits the process with a one-line reason when the opt-in is absent. Called
 * before anything else a paid script does, so a refusal costs nothing and
 * touches nothing.
 */
export function assertPaidRunOptIn(env = process.env, variable = PAID_RUN_OPT_IN) {
  const verdict = paidRunOptIn(env, variable);
  if (verdict.allowed) return verdict;
  process.stderr.write(`${verdict.reason}\n`);
  process.exit(1);
}
