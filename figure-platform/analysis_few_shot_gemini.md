# Analysis: `few_shot_benchmark_gemini3.5flash`

## Overview

31 figures across 7 chapters. Generator: `gpt-5.5`. Critic: `gemini-3.5-flash`. All evaluated under `few_shot_critic` version. The parallel experiment `few_shot_benchmark_gpt4.1` used the same generator and prompt setup but switched the critic to `gpt-4.1`.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 5 | 16% |
| 2 (stopped early) | 1 | 3% |
| 3 (hit max) | 25 | 81% |

The orchestrator ran to 3 attempts in **81% of cases** — notably higher than the GPT-4.1 experiment (63%). The 5 early-stops at iteration 1 were all figures that scored 4.6–4.8 on the first pass (`no_picture_on_a_wall`, `vanishing_lines_and_planes`, `office_vanishing_points_3`, `ames_room`, `camera_motion_field_rotation_three_f`). The single 2-attempt stop was `epipolar_game_play`, which hit a perfect 5.0 on iteration 2. The higher 3-attempt rate compared to GPT-4.1 reflects the Gemini critic's lower first-pass scores: figures that GPT-4.1 would have scored high enough to exit early still appear improvable to Gemini, keeping the loop running.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 26 figures with at least 2 iterations:

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| camera_forward_translation | 2.0 | 4.0 | **+2.0** |
| geometry_reconstruction_12 | 2.6 | 4.6 | **+2.0** |
| epipolar_game_play | 4.0 | 5.0 | **+1.0** |
| yaw_pitch_roll | 3.6 | 4.4 | +0.8 |
| office_measuring_desk_sketch | 3.8 | 4.4 | +0.6 |
| horizon_line | 3.4 | 4.0 | +0.6 |
| vanishing_points | 3.2 | 3.8 | +0.6 |
| pinhole_names2 | 4.2 | 4.6 | +0.4 |
| pinhole_geometry2 | 3.8 | 4.2 | +0.4 |
| triangularization_stereo | 3.2 | 3.6 | +0.4 |
| locating_a_3d_point | 3.0 | 3.4 | +0.4 |
| streetgeons | 3.0 | 3.4 | +0.4 |
| flying_bird | 3.2 | 3.6 | +0.4 |
| orthogonal_projection | 4.2 | 4.4 | +0.2 |
| similar_triangles2 | 4.2 | 4.4 | +0.2 |
| brdf | 4.2 | 4.4 | +0.2 |
| epipolar_3 | 4.2 | 4.4 | +0.2 |
| camera_lateral_translation | 3.6 | 3.6 | 0.0 |
| examples_3d_moving_points | 4.4 | 4.4 | 0.0 |
| basic_motion_point | 4.2 | 4.2 | 0.0 |
| sphereDiffuse | 4.4 | 4.2 | **-0.2** |
| epipolar_1 | 3.8 | 3.6 | -0.2 |
| axis_calibration_procedure | 3.8 | 3.6 | -0.2 |
| camera_lateral_translation_flow | 4.2 | 4.0 | -0.2 |
| epipolar_geometry | 3.4 | 3.0 | -0.4 |
| stereocnn | 3.6 | 2.8 | **-0.8** |

**17/26 improved, 3/26 flat, 6/26 dropped.** The second pass is net positive in the majority of cases (65% improve). This is better than the GPT-4.1 experiment, where only 54% of figures improved at iter 2 — but that gap is largely explained by GPT-4.1's higher starting scores leaving less room to grow. The drops here are modest (−0.2 to −0.4) except `stereocnn` which tanks hard at iter 2 (3.6 → 2.8) before recovering at iter 3. The two biggest gains (`camera_forward_translation` +2.0, `geometry_reconstruction_12` +2.0) both started from critically low first-pass scores — the loop is most valuable for recovering weak initial generations. GPT-4.1 also has a single extreme low first pass (1.0 for `camera_motion_field_rotation_three_f`), which recovered to 4.4 at iter 2.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| camera_forward_translation | 2.0 | 4.0 | **+2.0** |
| geometry_reconstruction_12 | 2.6 | 4.6 | **+2.0** |
| horizon_line | 3.4 | 5.0 | **+1.6** |
| streetgeons | 3.0 | 4.4 | +1.4 |
| triangularization_stereo | 3.2 | 4.4 | +1.2 |
| flying_bird | 3.2 | 4.4 | +1.2 |
| vanishing_points | 3.2 | 4.2 | +1.0 |
| locating_a_3d_point | 3.0 | 3.8 | +0.8 |
| axis_calibration_procedure | 3.8 | 4.4 | +0.6 |
| office_measuring_desk_sketch | 3.8 | 4.4 | +0.6 |
| pinhole_geometry2 | 3.8 | 4.4 | +0.6 |
| epipolar_geometry | 3.4 | 4.0 | +0.6 |
| stereocnn | 3.6 | 4.2 | +0.6 |
| camera_lateral_translation | 3.6 | 4.2 | +0.6 |
| sphereDiffuse | 4.4 | 5.0 | +0.6 |
| epipolar_1 | 3.8 | 4.2 | +0.4 |
| orthogonal_projection | 4.2 | 4.4 | +0.2 |
| similar_triangles2 | 4.2 | 3.2 | **-1.0** |
| camera_lateral_translation_flow | 4.2 | 3.8 | **-0.4** |
| pinhole_names2 | 4.2 | 4.2 | 0.0 |
| epipolar_3 | 4.2 | 4.2 | 0.0 |
| yaw_pitch_roll | 3.6 | 3.6 | 0.0 |
| brdf | 4.2 | 4.4 | +0.2 |
| examples_3d_moving_points | 4.4 | 4.6 | +0.2 |
| basic_motion_point | 4.2 | 4.4 | +0.2 |

**Only 2/25 multi-iteration figures ended up strictly worse than their first pass: `similar_triangles2` (−1.0) and `camera_lateral_translation_flow` (−0.4).** This net regression rate of 8% is low, though slightly higher than the GPT-4.1 experiment (1/26 = 4%). The GPT-4.1 critic's single regression is `epipolar_geometry` (−0.8), a figure that Gemini was actually able to improve (+0.6). Both experiments confirm that few-shot prompting substantially stabilizes the refinement loop compared to `auto_iter_results` (which showed ~66% regression).

---

## Patterns in the Third Pass

The third iteration is more mixed than the second.

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_geometry | 3.4 | 3.0 | 4.0 |
| epipolar_1 | 3.8 | 3.6 | 4.2 |
| stereocnn | 3.6 | 2.8 | 4.2 |
| axis_calibration_procedure | 3.8 | 3.6 | 4.4 |

4 figures show this pattern here, compared to 5 in the GPT-4.1 experiment. Iter 2 sometimes over-corrects or introduces new issues; iter 3 finds a better balance. The concern is that these figures pass through a worse intermediate state with no mechanism to revert.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| similar_triangles2 | 4.2 | 4.4 | **3.2** |
| yaw_pitch_roll | 3.6 | 4.4 | **3.6** |
| pinhole_names2 | 4.2 | 4.6 | 4.2 |
| epipolar_3 | 4.2 | 4.4 | 4.2 |

**4 figures** peaked at iter 2 and were harmed or unchanged by iter 3 — a significantly worse outcome than the GPT-4.1 experiment, which had only 1 such figure (`no_picture_on_a_wall_aina`). `similar_triangles2` and `yaw_pitch_roll` are the clearest examples: they are the source of both net regressions in this experiment. The GPT-4.1 critic appears to be better calibrated at recognizing when a figure has reached its ceiling and should stop.

### Steady improvement across all three passes

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| horizon_line | 3.4 | 4.0 | **5.0** |
| streetgeons | 3.0 | 3.4 | **4.4** |
| triangularization_stereo | 3.2 | 3.6 | **4.4** |
| flying_bird | 3.2 | 3.6 | **4.4** |
| locating_a_3d_point | 3.0 | 3.4 | 3.8 |

5 figures show consistent incremental gains across all three passes, the same count as GPT-4.1. `horizon_line` reaching 5.0 is the standout in this experiment; the GPT-4.1 equivalent (`camera_lateral_translation_flow` reaching 4.8) is strong but doesn't quite match it.

---

## Summary

- **The second iteration is the most consistently useful pass** — it improved 65% of figures (vs. 54% for GPT-4.1) and produced the two largest individual score jumps (+2.0 each). Gemini's higher improvement rate at iter 2 is primarily a function of its lower and wider first-pass scores, which leave more room to grow.
- **The third iteration is a wash overall**: it contributes steady gains for figures that started low, but is also responsible for the two worst regressions in the set. This problem is more pronounced here than in GPT-4.1 (4 peaked-at-iter-2 cases vs. 1).
- **The orchestrator almost never stops before 3 attempts** (81% hit the max, vs. 63% for GPT-4.1). The Gemini critic's stricter scoring keeps more figures in the loop past iter 2.
- **Net regression rate is very low (2/25 = 8%)** — slightly higher than GPT-4.1's 4% but still a significant improvement over `auto_iter_results`. Few-shot prompting appears to stabilize the refinement loop regardless of which critic model is used.
- **Key design implication**: an early-stopping rule based on score threshold (e.g., stop if iter 2 ≥ 4.5) would help both experiments, but would prevent more harm here specifically — `similar_triangles2` and `yaw_pitch_roll` both hit ≥ 4.4 at iter 2 before being degraded by iter 3.
