#!/usr/bin/env python3
"""Jev vs generative LLM on the same articles: agreement, speed, cost.

  python3 compare_scorers.py [--n 24] [--data DIR]

Uses articles already judged by Jev in the data dir, scores a sample with the configured LLM
(``ai.py`` provider — free OpenCode CLI by default) and prints a Markdown report.
"""

import argparse
import os
import random
import time
from pathlib import Path


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2.0
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx) ** 0.5
    vy = sum((b - my) ** 2 for b in ry) ** 0.5
    return cov / (vx * vy) if vx and vy else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=24)
    ap.add_argument("--data", default=None)
    args = ap.parse_args()
    if args.data:
        os.environ["USEFULNEWS_DATA_DIR"] = args.data
    import app as webapp  # noqa: E402  (reads the data dir env)
    import scoring

    s = webapp.settings()
    mem = webapp.memory()
    recent = webapp.store.recent(s["days"])
    jev = webapp.store.judgments("jev", [a["id"] for a in recent])
    pool = [a for a in recent if a["id"] in jev]
    random.Random(7).shuffle(pool)
    sample = pool[:args.n]
    if not sample:
        raise SystemExit("no Jev-judged articles yet — run a refresh in the app first")

    j_scorer = scoring.JevScorer(scoring.typesafe_key(webapp.ai.config_dir))
    t0 = time.time()
    fresh_jev = j_scorer.score(sample, s["profile"], mem)
    jev_secs = time.time() - t0

    llm = scoring.LLMScorer(webapp.ai)
    t0 = time.time()
    llm_out = llm.score(sample, s["profile"], mem)
    llm_secs = time.time() - t0

    both = [a for a in sample if a["id"] in fresh_jev and a["id"] in llm_out]
    uj = [scoring.usefulness(fresh_jev[a["id"]], s["weights"])["value"] for a in both]
    ul = [scoring.usefulness(llm_out[a["id"]], s["weights"])["value"] for a in both]
    topic_agree = sum(fresh_jev[a["id"]]["topic"] == llm_out[a["id"]]["topic"] for a in both) / max(1, len(both))
    mad = sum(abs(x - y) for x, y in zip(uj, ul)) / max(1, len(both))
    per_dim = {}
    for k in (*scoring.SCORES, *scoring.FLAGS):
        grp = "scores" if k in scoring.SCORES else "flags"
        per_dim[k] = spearman([fresh_jev[a["id"]][grp][k] for a in both], [llm_out[a["id"]][grp][k] for a in both])

    cfg = webapp.ai.load_config()
    print(f"# Jev vs LLM — {time.strftime('%Y-%m-%d')}\n")
    print(f"Sample: {len(both)} articles (of {len(sample)} requested). LLM: `{cfg['provider']}` / `{cfg['model']}`.\n")
    print("| | Jev | LLM |\n|---|---|---|")
    print(f"| wall time | {jev_secs:.1f} s | {llm_secs:.1f} s |")
    print(f"| cost | ≈ US$ {j_scorer.tokens * 0.042 / 1e6:.4f} ({j_scorer.tokens} input tokens) | depends on provider |")
    print(f"| failures | {len(fresh_jev.get('_errors', []))} | {len(llm_out.get('_errors', []))} |\n")
    print(f"- Usefulness rank agreement (Spearman): **{spearman(uj, ul):.2f}**")
    print(f"- Mean |Jev − LLM| usefulness: **{mad:.1f}** points")
    print(f"- Same topic: **{topic_agree:.0%}**")
    print("- Per-dimension rank agreement: " + ", ".join(f"{k} {v:.2f}" for k, v in per_dim.items()) + "\n")
    print("| Jev | LLM | title |\n|---|---|---|")
    for a, x, y in sorted(zip(both, uj, ul), key=lambda t: -abs(t[1] - t[2]))[:10]:
        print(f"| {x} | {y} | {a['title'][:90]} |")


if __name__ == "__main__":
    main()
