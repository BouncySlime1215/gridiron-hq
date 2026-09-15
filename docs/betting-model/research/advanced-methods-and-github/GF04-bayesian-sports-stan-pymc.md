# GF04 — Bayesian sports models (Stan / PyMC / NumPyro), dynamic bivariate Poisson

Agent: GF04-bayesian-sports-stan-pymc | bucket: fix | phase: GitHubFix
Scope: clone/read 4-6 real Bayesian sports repos, verify by reading code (not READMEs), and specify the posterior->JSON->Node export path.

## Repos read

### 1. LeoEgidi/footBayes — PRIMARY PORT TARGET
- URL: https://github.com/LeoEgidi/footBayes
- License: GPL-2 (from DESCRIPTION)
- Stars: 59 | Last commit: 2026-09-09 (3 days before this review; package version 2.1.0 dated 2026-09-07)
- Cloned: yes, full shallow clone, 5.9MB
- What it actually is (verified by reading `src/stan/*.stan` and `R/stan_foot.R`): an R package (CRAN-track, authored by Leonardo Egidi + academic co-authors, tied to a 2026 JRSS-C paper, doi:10.1093/jrsssc/qlag032) that compiles ~18 CmdStan models via the `instantiate` package and fits them through `rstan`/`cmdstanr`. It is NOT a toy — it is a real, currently-maintained multi-model Bayesian sports-modeling library.
- Read in full: `src/stan/biv_pois_dynamic.stan` (489 lines incl. functions block), `src/stan/neg_bin_dynamic.stan` (first 200+ lines), `R/stan_foot.R` (first 80 + return/extract logic).
- `biv_pois_dynamic.stan` implements the **Karlis & Ntzoufras (2003) bivariate Poisson** via a custom `bipois_lpmf` (correct normalizing constant, log-sum-exp trick over `min(y1,y2)`), with attack/defense abilities `att[t,team]`, `def[t,team]` following a **random-walk state-space evolution** across `ntimes` periods (`mu_att[t] = att[t-1]`), three interchangeable evolution-variance specifications actually implemented in the file:
  - Owen (2011): single shared `sigma_common`
  - Egidi et al. (2018): separate `sigma_att`/`sigma_def`
  - **Koopman & Lit (2015)**: `sigma_att_t[t] = sqrt(sigma_att_kl^2 + sigma_break^2 * is_summer_break[t])` — an honest variance-inflation term at season breaks, not a hand blend
  - Plus a 2026-paper "commensurate prior" spike-and-slab weighted-dynamic option (non-centered parameterization, `att_raw_std`) for shrinking team evolution toward either "no change" (spike) or "free random walk" (slab) per team/period — this is a genuine data-driven state-space update, the exact thing Gridiron's `nfl-team-strength.js` hand-tuned blend is not.
  - Home advantage `home[t]` is itself time-varying; there's a `gamma` term letting an external ranking/rating series shrink `theta_home`/`theta_away`.
  - `generated quantities` block does posterior-predictive score replication (`y_rep`) and computes `log_lik` per game — i.e., it ships its own calibration/LOO hooks.
- `neg_bin_dynamic.stan` mirrors the same dynamic state-space attack/defense structure but swaps the bivariate-Poisson likelihood for a **dynamic hierarchical Negative Binomial** — real overdispersion modeling for count outcomes, with the identical Owen/Koopman-Lit/commensurate variance machinery. This is directly the missing piece for player props (currently point estimates, no NB/hierarchical/calibrated model).
- `stan_foot()` in R fits via CmdStan, returns an object holding the raw `stanfit`/`CmdStanMCMC`; posterior extraction elsewhere in the package uses `posterior::` (imported in DESCRIPTION) and `matrixStats`.
- Adopt: **port**. Concrete attachment: run `biv_pois_dynamic.stan` and `neg_bin_dynamic.stan` from a small R/CmdStanR (or hand-translate to `cmdstanpy`) sidecar, feed it Gridiron's existing team/week schedule + score table, and export the posterior as described below for `server/services/nfl-team-strength.js` and the props module to consume.

### 2. pymc-devs/pymc-examples — reference / borrow-idea
- URL: https://github.com/pymc-devs/pymc-examples
- License: MIT | Stars: 398 | Last commit: 2026-09-09 (repo actively maintained; the specific rugby notebook is dated 19 Mar 2022 but still ships in the current tree)
- **Not fully cloned** — repo is 1.15GB (over the 200MB clone-skip threshold). Read via `gh api repos/.../contents/examples/case_studies/rugby_analytics.myst.md` (489-line myst notebook, fetched and read in full) instead of a git clone.
- What it actually does: this is the canonical **Baio & Blangiardo (2010)** hierarchical Poisson model, in current PyMC 5 syntax (`pm.Model`, `pt.exp`, `pm.Deterministic` sum-to-zero constraints), authored by PyMC core contributors (Peadar Coyle, Meenal Jhajharia, Oriol Abril-Pla). Verified real code:
  ```python
  atts = pm.Deterministic("atts", atts_star - pt.mean(atts_star), dims="team")
  home_theta = pt.exp(intercept + home + atts[home_idx] + defs[away_idx])
  home_points = pm.Poisson("home_points", mu=home_theta, observed=df_all["home_score"], dims="match")
  trace = pm.sample(1000, tune=1500, cores=4)
  ```
  This is a **static** (non-dynamic) hierarchical model — no time-varying abilities, independent (not bivariate) Poisson for home/away scores. Confirms and gives a textbook baseline for exactly the part of footBayes that adds the dynamic + bivariate extensions.
  Diagnostics used post-fit are real and worth copying: `az.plot_energy`, `az.summary(kind="diagnostics")`, `az.hdi(trace)` for credible intervals per team, `az.plot_forest`.
- Adopt: **borrow-idea / reference-only**. Not a port target itself (footBayes is a strict superset — dynamic + bivariate + this same static-Poisson idea), but the notebook is the cleanest documented worked example of the sum-to-zero attack/defense parameterization and of `arviz`'s diagnostic checklist (rhat/energy/hdi), which Gridiron currently has none of anywhere in the pipeline.

### 3. martineastwood/penaltyblog — CALL target (lightweight tier)
- URL: https://github.com/martineastwood/penaltyblog
- License: MIT (LICENCE file, Martin Eastwood, 2021) | Stars: 220 | Last commit: 2026-09-10 (1 day before review — actively maintained pip package, "high-performance football analytics")
- Cloned: yes, full shallow clone, 5.2MB
- What it actually does (verified in `penaltyblog/models/hierarchical_bayesian_goal_model.py`, `penaltyblog/bayes/sampler_api.py`, `penaltyblog/bayes/likelihood.pyx`): this is **not** Stan/PyMC — it's a from-scratch, dependency-light Bayesian engine:
  - `sampler.py` (`DiffEvolEnsembleSampler`) is a hand-rolled differential-evolution ensemble MCMC sampler (emcee-style), run via a multiprocessing pool (`_worker_proxy`, picklability checks for spawn-mode on macOS/Windows) — no CmdStan/PyStan/NumPyro dependency at all.
  - The actual log-posterior is Cython (`likelihood.pyx`, `_hierarchical_log_prob_c`, `nogil`): attack/defense parameters get a **hierarchical prior with learned team-level variance** (`sigma_att`, `sigma_def` as free parameters, half-normal hyperprior), a sum-to-zero soft constraint (`CONSTRAINT_VARIANCE = 0.001` penalty rather than a hard analytic constraint), and the likelihood itself is a **Dixon-Coles-weighted negative log-likelihood with a correlation parameter `rho`** (`dixon_coles_neg_ll_c`) — i.e., low-score correlation adjustment, not the Karlis-Ntzoufras bivariate-Poisson construction footBayes uses. So "Bayesian" here means real MCMC over a real hierarchical prior, but the correlation structure is the (weaker) Dixon-Coles tau adjustment, not a joint bivariate distribution.
  - `HierarchicalBayesianGoalModel.fit()` runs `n_chains` independent chains, each `n_samples` post-burn draws, and materializes `self.trace` as a plain **numpy array** `[n_total_draws, n_teams*2 + 4]`, then `self._map_trace_to_dict()` builds `self.trace_dict[param_name] = np.ndarray` — this is about as JSON-friendly as it gets (see export spec below).
- Adopt: **call**. `pip install penaltyblog`, run `HierarchicalBayesianGoalModel` as a small Python service/subprocess Gridiron's Node code shells out to weekly (no CmdStan install/compile step required, unlike footBayes) — the cheap, always-available tier; footBayes stays the deeper/slower tier run less often.

### 4. lbenz730/soccer_ha_covid — reference-only (published methodology)
- URL: https://github.com/lbenz730/soccer_ha_covid
- License: none set (repo has no LICENSE file/field) | Stars: 13 | Last commit: 2021-05-28 (stale, but code is the working artifact behind a peer-reviewed paper: Benz & Lopez, "Estimating the change in soccer's home advantage during the Covid-19 pandemic using bivariate Poisson regression" — Michael Lopez is the NFL's Head of Football Data & Analytics, so this is not an anonymous hobby repo)
- **Not fully cloned** — repo tree is 4.5GB (far over the 200MB threshold, mostly `fbref_data/` scrape caches and `eda/paper_figures/figures/` PNGs). Read specific files in full via `gh api .../contents/<path>` (base64-decoded): `models/goals/bvp_goals_lambda3.R` (95 lines), `stan/goals/bvp_goals_lambda3.stan` (75 lines, read in full), `helpers.R`, `README.md`.
- What it actually does (verified in the Stan file itself): a **bivariate Poisson via the Karlis-Ntzoufras shared-intercept trick** —
  ```stan
  lambda1[g] = exp(mu[season[g]] + home_field_pre*ind_pre[g] + home_field_post*(1-ind_pre[g]) + alpha[home] + delta[away]);
  lambda2[g] = exp(mu[season[g]] + alpha[away] + delta[home]);
  lambda3[g] = exp(fixed_cov);          // shared covariance term
  h_goals ~ poisson(lambda1 + lambda3);
  a_goals ~ poisson(lambda2 + lambda3);
  ```
  with an **empirical-Bayes prior split on home-field advantage pre- vs. post-COVID** (`home_field_pre`, `home_field_post`, priors centered on external empirical baselines with `sd = 3*sd(baseline)`), run via `rstan::stan(..., iter=20000, warmup=10000, control=list(adapt_delta=0.95))`, then `posterior <- rstan::extract(model); write_rds(...)`. This confirms the exact same Karlis-Ntzoufras `lambda3` construction as footBayes' `biv_pois.stan`, from an independent, published implementation — good corroboration that this is the standard approach, not one package's idiosyncrasy.
- Adopt: **reference-only** (no license to port cleanly, code is stale/single-purpose, heavy in scraped data). Borrow the idea: a shared-intercept covariance term is the textbook way to give two correlated Poisson counts real joint structure — directly relevant as the dependence-model Gridiron's teaser/same-game correlation code is missing.

### 5. pjastam/r-bayesian-football-odds — reference-only (contrast case, not Stan/PyMC)
- URL: https://github.com/pjastam/r-bayesian-football-odds
- License: MIT (2022, Piet Stam) | Stars: 3 | Last commit: 2022-09-02
- Cloned: yes, full shallow clone, 988KB
- What it actually does (verified `NL_eredivisie_2014_2019.R`, line 48 `m3_string <- "model {"`, line 2 `library(runjags)`): this is **JAGS**, not Stan/PyMC/NumPyro — flagged explicitly since the task scoped those three toolkits. Fits a hierarchical Poisson model for Dutch Eredivisie match goals via `runjags::run.jags(method="parallel", ...)`. Small, single-league, educational-scale (5 seasons of data bundled as CSVs).
- Adopt: **reference-only**. Included to document that it was checked and explicitly does not meet the Stan/PyMC/NumPyro bar — not a candidate for porting or calling, kept only as a second data point that the hierarchical-Poisson structure is a recurring, well-understood pattern independent of toolkit.

## How the posterior gets to Node as JSON (concrete, per source)

**From footBayes / raw CmdStan (R side, `posterior` package draws):**
```r
draws_df <- posterior::as_draws_df(fit$draws())        # one row per (chain, iteration), one column per parameter element e.g. "att[3,7]"
jsonlite::write_json(as.list(draws_df), "posterior_draws.json", auto_unbox = FALSE)
# plus a small metadata file Node needs to reshape "att[t,team]" strings back into a matrix:
meta <- list(nteams = nteams, ntimes = ntimes, team_names = team_names, time_labels = time_labels,
             n_draws = nrow(draws_df), n_chains = fit$num_chains())
jsonlite::write_json(meta, "posterior_meta.json", auto_unbox = TRUE)
```
Node then does `JSON.parse`, regex-parses the `"att[t,team]"` keys against `posterior_meta.json` to rebuild a `[ntimes][nteams]` array of per-draw vectors — no Stan runtime needed in Node at all, this is a pure data hand-off.
For the common case where Node only needs summary uncertainty (not every draw, to keep payloads small for a weekly cron job), export `posterior::summarise_draws(fit$draws(c("att","def","home","rho")), mean, sd, ~quantile(.x, c(.025,.5,.975)))` as JSON instead — gives Gridiron real (mean, sd, 95% CI) per team/period, replacing the assumed-normal-SD point forecasts flagged in tonight's findings.
For game-level predictive draws (what a Monte Carlo drive/season simulator actually consumes), export the `generated quantities` `y_rep`/`theta_home`/`theta_away`/`theta_corr` arrays the same way — these plug straight into a Node-side scorer without re-deriving anything.

**From pymc-examples / arviz `InferenceData`:**
Robust, version-independent recipe (doesn't rely on remembering an exact arviz convenience-method signature): pull each variable's raw array and call `.values.tolist()`, which turns the numpy array into nested native Python lists that `json.dump` can serialize directly —
```python
posterior = {var: idata.posterior[var].values.tolist() for var in ["atts", "defs", "home", "intercept", "sd_att", "sd_def"]}
# shape per var is [n_chains, n_draws, ...]; flatten chains client-side or here with .stack(sample=("chain","draw"))
import json
json.dump({"posterior": posterior, "coords": {"team": list(idata.posterior.coords["team"].values)}}, open("posterior.json", "w"))
```

**From penaltyblog (already the easiest case — plain numpy, no PyMC/Stan object to unwrap):**
```python
import json
out = {k: v.tolist() for k, v in model.trace_dict.items()}   # trace_dict already built by _map_trace_to_dict()
out["team_names"] = model.teams
json.dump(out, open("posterior.json", "w"))
```

## Do-not-do
- Do not run CmdStan/rstan/PyMC inside the live Node process or the live Week-1-capture server — these are separate offline/cron fits (weekly cadence at most) whose *output* (JSON draws or summaries) is read by Node; the sampler itself never touches the production request path.
- Do not port lbenz730/soccer_ha_covid's code directly — no license. Its bivariate-Poisson-with-shared-intercept construction is the same one already present (with a clean GPL-2 license) in footBayes; use footBayes as the actual code source and cite Benz & Lopez only as corroborating methodology.
- Do not treat pjastam's JAGS model as an implementation target — it was read and excluded on toolkit grounds per the task scope.
