"""Inference helpers. Bets inside one game move together, so everything resamples games."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import stats as sps


@dataclass(frozen=True)
class RatioCI:
    point: float
    lo: float
    hi: float
    p_le_zero: float
    n_clusters: int
    n: int


def cluster_bootstrap_ratio(num, den, clusters, n_boot: int = 10000, seed: int = 0, level: float = 0.95) -> RatioCI:
    """Bootstrap sum(num) / sum(den), resampling whole clusters with replacement.

    p_le_zero is the one-sided bootstrap p-value for "the ratio is not positive",
    with the usual add-one so it is never exactly zero.
    """
    num = np.asarray(num, dtype=float)
    den = np.asarray(den, dtype=float)
    uniq, inv = np.unique(np.asarray(clusters), return_inverse=True)
    g = len(uniq)
    if g < 2:
        raise ValueError("need at least two clusters to bootstrap")
    cn = np.bincount(inv, weights=num, minlength=g)
    cd = np.bincount(inv, weights=den, minlength=g)
    rng = np.random.default_rng(seed)
    out = np.empty(n_boot)
    chunk = max(1, min(n_boot, int(2e7 // g)))
    probs = np.full(g, 1.0 / g)
    for i in range(0, n_boot, chunk):
        w = rng.multinomial(g, probs, size=min(chunk, n_boot - i))
        out[i:i + len(w)] = (w @ cn) / (w @ cd)
    a = (1.0 - level) / 2.0
    lo, hi = np.quantile(out, [a, 1.0 - a])
    p = (np.sum(out <= 0.0) + 1) / (n_boot + 1)
    return RatioCI(float(cn.sum() / cd.sum()), float(lo), float(hi), float(p), g, len(num))


@dataclass(frozen=True)
class LogitFit:
    names: tuple
    params: tuple
    se: tuple
    n: int
    n_clusters: int

    def coef(self, name: str) -> float:
        return self.params[self.names.index(name)]

    def stderr(self, name: str) -> float:
        return self.se[self.names.index(name)]

    def z(self, name: str, null: float = 0.0) -> float:
        return (self.coef(name) - null) / self.stderr(name)


def logit_fit(y, X, names, clusters) -> LogitFit:
    """Logistic regression with cluster-robust (sandwich) standard errors."""
    import statsmodels.api as sm

    y = np.asarray(y, dtype=float)
    X = np.asarray(X, dtype=float)
    groups = np.unique(np.asarray(clusters), return_inverse=True)[1]
    res = sm.GLM(y, X, family=sm.families.Binomial()).fit(cov_type="cluster", cov_kwds={"groups": groups})
    return LogitFit(tuple(names), tuple(map(float, res.params)), tuple(map(float, res.bse)), len(y), int(groups.max()) + 1)


@dataclass(frozen=True)
class SlopeFit:
    slope: float
    intercept: float
    slope_se: float
    p_slope_gt_1: float
    n: int
    n_clusters: int


def calibration_slope(y, p0, clusters) -> SlopeFit:
    """Fit logit P(y) = a + b * logit(p0). b > 1 is a favourite-longshot bias.

    p_slope_gt_1 is the one-sided p-value against the null b <= 1.
    """
    p0 = np.asarray(p0, dtype=float)
    x = np.log(p0 / (1.0 - p0))
    fit = logit_fit(y, np.column_stack([np.ones_like(x), x]), ("const", "logit_p0"), clusters)
    z = fit.z("logit_p0", null=1.0)
    return SlopeFit(fit.coef("logit_p0"), fit.coef("const"), fit.stderr("logit_p0"), float(sps.norm.sf(z)), fit.n, fit.n_clusters)


def holm(pvals) -> list[float]:
    """Holm step-down adjusted p-values, returned in the input order."""
    p = np.asarray(pvals, dtype=float)
    m = len(p)
    order = np.argsort(p)
    adj = np.empty(m)
    running = 0.0
    for rank, idx in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[idx]))
        adj[idx] = running
    return adj.tolist()
