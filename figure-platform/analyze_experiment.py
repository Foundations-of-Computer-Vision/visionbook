#!/usr/bin/env python3
"""
Analyze figure generation results for a given experiment.

Usage:
    python analyze_experiment.py <experiment_name>

Output:
    analysis_<experiment_name>.md next to this script
"""

import json
import sys
import os
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
MANIFEST_PATH = SCRIPT_DIR / "backend" / "manifest.json"
RESULTS_DIR = SCRIPT_DIR / "backend" / "results"


def load_manifest(experiment_name):
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        manifest = json.load(f)
    entries = [r for r in manifest["results"] if r.get("experiment") == experiment_name]
    if not entries:
        raise SystemExit(f"No entries found for experiment '{experiment_name}'")
    return entries


def get_iteration_scores(entry):
    """Return list of overall_average floats, one per attempt, in iteration order."""
    result_path = RESULTS_DIR / f"{entry['id']}.json"
    with open(result_path, encoding="utf-8") as f:
        data = json.load(f)
    scores = []
    for attempt in sorted(data.get("attempts", []), key=lambda a: a.get("iteration", 0)):
        score = attempt.get("evaluation", {}).get("overall_average")
        if score is not None:
            scores.append(float(score))
    return scores


def fmt(x):
    """Format a score as a clean string (remove trailing .0)."""
    return str(int(x)) if x == int(x) else str(x)


def delta_str(d):
    if d > 0:
        return f"+{fmt(d)}"
    if d < 0:
        return f"{fmt(d)}"
    return "0.0"


def bold(s):
    return f"**{s}**"


def analyze(experiment_name):
    entries = load_manifest(experiment_name)

    # Collect per-figure data
    figures = []
    for e in entries:
        name = Path(e["filename"]).stem
        iters = e.get("iterations", 1)
        chapter = e.get("chapter", "?")
        model = e.get("model", "?")
        scores = get_iteration_scores(e)
        figures.append({
            "name": name,
            "id": e["id"],
            "chapter": chapter,
            "model": model,
            "iters": iters,
            "scores": scores,
        })

    figures.sort(key=lambda f: (-f["iters"], f["name"]))

    n_total = len(figures)
    iter_counts = {1: 0, 2: 0, 3: 0}
    for f in figures:
        iter_counts[f["iters"]] = iter_counts.get(f["iters"], 0) + 1

    # Figures with at least 2 iterations (have a meaningful iter1 vs iter2)
    multi = [f for f in figures if f["iters"] >= 2]

    # ── Iter 1 vs Iter 2 ──────────────────────────────────────────────────────
    iter1v2_rows = []
    for f in multi:
        s = f["scores"]
        iter1 = s[0] if len(s) > 0 else None
        iter2 = s[1] if len(s) > 1 else None
        if iter1 is None or iter2 is None:
            continue
        d = round(iter2 - iter1, 2)
        is_final = f["iters"] == 2
        iter2_cell = f"{fmt(iter2)} →" if is_final else fmt(iter2)
        d_cell = delta_str(d)
        if abs(d) >= 1.0:
            d_cell = bold(d_cell)
        iter1v2_rows.append((f["name"], iter1, iter2, d, iter2_cell, d_cell, is_final))

    iter1v2_rows.sort(key=lambda r: -r[3])

    improved_i2 = sum(1 for r in iter1v2_rows if r[3] > 0)
    flat_i2     = sum(1 for r in iter1v2_rows if r[3] == 0)
    dropped_i2  = sum(1 for r in iter1v2_rows if r[3] < 0)

    # ── Final vs Iter 1 (net regression) ──────────────────────────────────────
    net_rows = []
    for f in multi:
        s = f["scores"]
        iter1 = s[0] if len(s) > 0 else None
        final = s[-1] if len(s) > 0 else None
        if iter1 is None or final is None:
            continue
        d = round(final - iter1, 2)
        d_cell = delta_str(d)
        if abs(d) >= 1.0:
            d_cell = bold(d_cell)
        net_rows.append((f["name"], iter1, final, d, d_cell))

    net_rows.sort(key=lambda r: -r[3])

    net_improved  = sum(1 for r in net_rows if r[3] > 0)
    net_flat      = sum(1 for r in net_rows if r[3] == 0)
    net_regressed = sum(1 for r in net_rows if r[3] < 0)

    # ── Third-pass patterns ────────────────────────────────────────────────────
    three_iter = [f for f in figures if f["iters"] == 3 and len(f["scores"]) == 3]

    dip_recovery     = []  # iter2 < iter1, iter3 > iter2
    peaked_at_iter2  = []  # iter2 > iter1, iter3 < iter2
    improved_flat    = []  # iter2 > iter1, iter3 == iter2 (iter3 wasted)
    steady           = []  # iter3 > iter2 >= iter1 (every pass added something, iter3 useful)
    flat_then_gain   = []  # iter2 == iter1, iter3 > iter2 (only iter3 helped)
    flat_all         = []  # all three equal
    never_recovered  = []  # final < iter1

    for f in three_iter:
        s1, s2, s3 = f["scores"]
        # These categories are mutually exclusive
        if s2 < s1 and s3 > s2:
            dip_recovery.append(f)
        elif s2 > s1 and s3 < s2:
            peaked_at_iter2.append(f)
        elif s2 > s1 and s3 == s2:
            improved_flat.append(f)
        elif s3 > s2 and s2 >= s1:
            # iter3 strictly improved; iter2 may have improved or been flat
            if s2 > s1:
                steady.append(f)       # both iter2 and iter3 helped
            else:
                flat_then_gain.append(f)   # only iter3 helped
        elif s1 == s2 == s3:
            flat_all.append(f)

        if s3 < s1:
            never_recovered.append(f)

    # Summary stats
    all_first_scores = [f["scores"][0] for f in figures if f["scores"]]
    all_final_scores = [f["scores"][-1] for f in figures if f["scores"]]
    avg_first = round(sum(all_first_scores) / len(all_first_scores), 2)
    avg_final = round(sum(all_final_scores) / len(all_final_scores), 2)

    # ── Chapter breakdown ──────────────────────────────────────────────────────
    chapter_scores = {}
    for f in figures:
        ch = f["chapter"]
        final = f["scores"][-1] if f["scores"] else None
        if final is not None:
            chapter_scores.setdefault(ch, []).append(final)
    chapter_avgs = {ch: round(sum(v)/len(v), 2) for ch, v in chapter_scores.items()}
    chapter_avgs_sorted = sorted(chapter_avgs.items(), key=lambda x: x[1])

    # ── Unique models/critics ──────────────────────────────────────────────────
    unique_models  = sorted(set(f["model"] for f in figures))
    critic_models  = sorted(set(
        list(entries[0].get("evaluationMeta", {}).keys()) if entries else []
    ))

    # ─────────────────────────────────────────────────────────────────────────
    # BUILD MARKDOWN
    # ─────────────────────────────────────────────────────────────────────────
    lines = []
    L = lines.append

    L(f"# Analysis: `{experiment_name}`\n")
    L("## Overview\n")
    L(f"{n_total} figures across {len(chapter_scores)} chapters. "
      f"Generator: `{'`, `'.join(unique_models)}`. "
      f"Critic: `{'`, `'.join(critic_models) if critic_models else '?'}`. "
      f"Critic version: `few_shot_critic`.\n")
    L(f"Average first-pass score: **{avg_first}**. Average final score: **{avg_final}**.\n")
    L("---\n")

    # Orchestrator
    L("## Orchestrator Attempt Distribution\n")
    L("| Iterations used | Count | % |")
    L("|---|---|---|")
    for k in sorted(iter_counts):
        pct = round(100 * iter_counts[k] / n_total)
        label = "stopped early" if k < 3 else "hit max"
        L(f"| {k} ({label}) | {iter_counts[k]} | {pct}% |")
    L("")
    max_iter_pct = round(100 * iter_counts.get(3, 0) / n_total)
    early_stops = [f for f in figures if f["iters"] == 1]
    if early_stops:
        stop_names = ", ".join(f"`{f['name']}`" for f in early_stops)
        L(f"The orchestrator ran to 3 attempts in **{max_iter_pct}% of cases**. "
          f"The {len(early_stops)} early-stop(s) at iteration 1: {stop_names}.\n")
    else:
        L(f"The orchestrator ran to 3 attempts in **{max_iter_pct}% of cases**. No figures exited after a single pass.\n")
    L("---\n")

    # Iter 1 vs Iter 2
    L("## Iteration 1 vs. Iteration 2 (first vs. second pass)\n")
    L(f"For the {len(multi)} figures with at least 2 iterations "
      f"(figures marked `→` exited after iteration 2):\n")
    L("| Figure | Iter 1 | Iter 2 | Δ |")
    L("|---|---|---|---|")
    for name, iter1, iter2, d, iter2_cell, d_cell, is_final in iter1v2_rows:
        L(f"| {name} | {fmt(iter1)} | {iter2_cell} | {d_cell} |")
    L("")
    L(f"**{improved_i2}/{len(iter1v2_rows)} improved, {flat_i2}/{len(iter1v2_rows)} flat, "
      f"{dropped_i2}/{len(iter1v2_rows)} dropped** at iteration 2.\n")
    L("---\n")

    # Net regression
    L("## Score Regression: Final Score vs. Iter 1\n")
    L("| Figure | Iter 1 | Final | Net Δ |")
    L("|---|---|---|---|")
    for name, iter1, final, d, d_cell in net_rows:
        L(f"| {name} | {fmt(iter1)} | {fmt(final)} | {d_cell} |")
    L("")
    if net_regressed == 0:
        L("**No figures ended up strictly worse than their first pass.** Net regression rate: 0%.\n")
    else:
        regressed_names = ", ".join(
            f"`{r[0]}` ({delta_str(r[3])})" for r in net_rows if r[3] < 0
        )
        L(f"**{net_regressed}/{len(net_rows)} figure(s) ended up strictly worse than their first pass: "
          f"{regressed_names}.** Net regression rate: {round(100*net_regressed/len(net_rows))}%.\n")
    L("---\n")

    # Third-pass patterns
    L("## Patterns in the Third Pass\n")

    def three_pass_table(figs):
        rows = ["| Figure | Iter 1 | Iter 2 | Iter 3 |", "|---|---|---|---|"]
        for f in figs:
            s = f["scores"]
            rows.append(f"| {f['name']} | {fmt(s[0])} | {fmt(s[1])} | {fmt(s[2])} |")
        return "\n".join(rows)

    if dip_recovery:
        L("### Dip-then-recovery (iter 2 bad, iter 3 recovers)\n")
        L(three_pass_table(dip_recovery))
        L("")
        L(f"{len(dip_recovery)} figure(s) passed through a worse state at iteration 2 before recovering at iteration 3.\n")

    if peaked_at_iter2:
        L("### Peaked at iter 2, iter 3 regresses\n")
        L(three_pass_table(peaked_at_iter2))
        L("")
        L(f"{len(peaked_at_iter2)} figure(s) peaked at pass 2 with no mechanism to stop there.\n")

    if improved_flat:
        L("### Improved at iter 2, flat at iter 3\n")
        L(three_pass_table(improved_flat))
        L("")
        L(f"{len(improved_flat)} figure(s) improved at iter 2 then plateaued — iter 3 was a wasted pass.\n")

    if steady:
        L("### Steady improvement: both iter 2 and iter 3 helped\n")
        L(three_pass_table(steady))
        L("")
        L(f"{len(steady)} figure(s) improved at both iter 2 and iter 3 — all three passes were useful.\n")

    if flat_then_gain:
        L("### Flat at iter 2, improved at iter 3\n")
        L(three_pass_table(flat_then_gain))
        L("")
        L(f"{len(flat_then_gain)} figure(s) showed no gain at iter 2 but improved at iter 3.\n")

    if flat_all:
        L("### Flat across all three passes\n")
        L(three_pass_table(flat_all))
        L("")
        L(f"{len(flat_all)} figure(s) showed no change across all iterations.\n")

    if never_recovered:
        L("### Never recovered: net regression to final\n")
        L(three_pass_table(never_recovered))
        L("")
        L(f"{len(never_recovered)} figure(s) ended iteration 3 below their iteration 1 score.\n")

    L("---\n")

    # Chapter breakdown
    L("## Chapter Breakdown (average final score)\n")
    L("| Chapter | Figures | Avg Final Score |")
    L("|---|---|---|")
    for ch, avg in chapter_avgs_sorted:
        L(f"| {ch} | {len(chapter_scores[ch])} | {avg} |")
    L("")
    L("---\n")

    # Summary
    L("## Summary\n")
    L(f"- **{n_total} figures** evaluated; average first-pass score **{avg_first}**, average final score **{avg_final}**.")
    L(f"- **Orchestrator**: {max_iter_pct}% of figures hit the 3-attempt ceiling.")
    L(f"- **Iter 1→2**: {improved_i2}/{len(iter1v2_rows)} improved ({round(100*improved_i2/len(iter1v2_rows))}%), "
      f"{flat_i2} flat, {dropped_i2} dropped.")
    L(f"- **Net regression** (final vs. iter 1): {net_regressed}/{len(net_rows)} = "
      f"{round(100*net_regressed/len(net_rows))}% ended below their first-pass score.")
    if dip_recovery:
        L(f"- **Dip-then-recovery**: {len(dip_recovery)} figure(s) degraded at iter 2 but recovered at iter 3.")
    if peaked_at_iter2:
        L(f"- **Peaked at iter 2**: {len(peaked_at_iter2)} figure(s) were harmed by a third pass they didn't need.")
    if improved_flat:
        L(f"- **Plateaued after iter 2**: {len(improved_flat)} figure(s) — iter 3 added nothing.")
    if flat_then_gain:
        L(f"- **Flat at iter 2, gained at iter 3**: {len(flat_then_gain)} figure(s) — iter 2 was the wasted pass.")
    if never_recovered:
        L(f"- **Permanent regression**: {len(never_recovered)} figure(s) never returned to their iter-1 score by iter 3.")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python analyze_experiment.py <experiment_name>")

    experiment_name = sys.argv[1]
    md = analyze(experiment_name)

    safe_name = experiment_name.replace("/", "_").replace(" ", "_")
    out_path = SCRIPT_DIR / f"analysis_{safe_name}.md"
    out_path.write_text(md, encoding="utf-8")
    print(f"Written to {out_path}")


if __name__ == "__main__":
    main()
