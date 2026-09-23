"""RL-8-2: consensus vs humans in executed Sleeper trades, graded in LINEUP points (skeleton, RED commit)."""

MDE_Z = 1.6449 + 0.8416
REPL_PPG_DEFAULT = {}


def orient(rids, adds, drops, rng, rng2):
    raise NotImplementedError


def value_diff(recv, give, shape, repl=None):
    raise NotImplementedError


def is_disagreement(x_con, x_std):
    raise NotImplementedError


def win_rate(pairs):
    raise NotImplementedError


def signed_mean(pairs):
    raise NotImplementedError


def per_week(total, weeks):
    raise NotImplementedError


def cluster_boot(rows, stat, key, reps=2000, seed=11):
    raise NotImplementedError


def mde80(se):
    raise NotImplementedError


def gate_verdict(rate, lo_chain, lo_week, pts_lo_chain):
    raise NotImplementedError
