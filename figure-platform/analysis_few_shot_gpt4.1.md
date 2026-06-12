# Analysis: `few_shot_benchmark_gpt4.1`

## Overview

32 figures across 8 chapters. Generator: `gpt-5.5`. Critic: `gpt-4.1`. All evaluated under `few_shot_critic` version.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 6 | 19% |
| 2 (stopped early) | 6 | 19% |
| 3 (hit max) | 20 | 63% |

The orchestrator ran to 3 attempts in **63% of cases** — notably lower than the Gemini experiment (81%). This is consistent with GPT-4.1's higher first-pass scores: six figures scored ≥ 4.2 on the first pass and exited early (`epipolar_game_play` 4.2, `axis_calibration_procedure` 4.4, `locating_a_3d_point` 4.4, `vanishing_points` 4.6, `orthogonal_projection` 4.6, `similar_triangles2` 4.6). Six more figures exited after exactly 2 iterations — most of them showing large iter-1→iter-2 jumps. One extreme outlier: `camera_motion_field_rotation_three_f` scored 1.0 on the first pass (broken generation) before recovering to 4.4 at iteration 2.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 26 figures with at least 2 iterations. The 6 two-iteration figures exit here; `→` marks final score for those.

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 1.0 | **4.4 →** | **+3.4** |
| office_measuring_desk_sketch | 3.4 | 4.4 | **+1.0** |
| examples_3d_moving_points | 3.2 | 4.2 | **+1.0** |
| flying_bird | 3.4 | 4.4 | **+1.0** |
| basic_motion_point | 3.4 | 4.4 | **+1.0** |
| vanishing_lines_and_planes | 3.2 | 4.0 | +0.8 |
| ames_room | 4.2 | 3.4 | **-0.8** |
| no_picture_on_a_wall_aina | 3.6 | 4.4 | +0.8 |
| spherePhongRoughness0.3 | 3.8 | **4.6 →** | +0.8 |
| sphereDiffuse | 4.2 | 4.6 | +0.4 |
| streetgeons | 3.0 | 3.6 | +0.6 |
| camera_lateral_translation_flow | 3.8 | 4.4 | +0.6 |
| brdf | 4.2 | **4.8 →** | +0.6 |
| camera_lateral_translation | 3.8 | **4.4 →** | +0.6 |
| pinhole_names2 | 4.4 | **4.6 →** | +0.2 |
| pinhole_geometry2 | 4.0 | 4.0 | 0.0 |
| epipolar_3 | 4.2 | 4.2 | 0.0 |
| triangularization_stereo | 4.4 | 4.4 | 0.0 |
| office_vanishing_points_3 | 4.4 | 4.4 | 0.0 |
| yaw_pitch_roll | 4.4 | 4.4 | 0.0 |
| horizon_line | 4.6 | **4.6 →** | 0.0 |
| epipolar_1 | 3.4 | 3.2 | -0.2 |
| stereocnn | 4.2 | 3.8 | -0.4 |
| geometry_reconstruction_12 | 4.0 | 3.4 | -0.6 |
| camera_forward_translation | 4.4 | 3.6 | -0.8 |
| epipolar_geometry | 4.4 | 3.4 | **-1.0** |

**14/26 improved, 6/26 flat, 6/26 dropped** at iteration 2. This is a lower improvement rate than the Gemini experiment (17/26 = 65% vs. 54% here), which is consistent with GPT-4.1's higher baseline — there is simply less room to improve from a 4.2+ starting score. The six drops are all notable: `ames_room`, `camera_forward_translation`, and `epipolar_geometry` each fell by 0.8–1.0 at iter 2 before iter 3 had a chance to recover.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 1.0 | 4.4 | **+3.4** |
| streetgeons | 3.0 | 4.6 | **+1.6** |
| office_measuring_desk_sketch | 3.4 | 4.6 | +1.2 |
| examples_3d_moving_points | 3.2 | 4.2 | +1.0 |
| flying_bird | 3.4 | 4.4 | +1.0 |
| basic_motion_point | 3.4 | 4.4 | +1.0 |
| camera_lateral_translation_flow | 3.8 | 4.8 | +1.0 |
| epipolar_1 | 3.4 | 4.4 | +1.0 |
| vanishing_lines_and_planes | 3.2 | 4.2 | +1.0 |
| spherePhongRoughness0.3 | 3.8 | 4.6 | +0.8 |
| no_picture_on_a_wall_aina | 3.6 | 3.8 | +0.2 |
| stereocnn | 4.2 | 4.8 | +0.6 |
| camera_lateral_translation | 3.8 | 4.4 | +0.6 |
| brdf | 4.2 | 4.8 | +0.6 |
| pinhole_geometry2 | 4.0 | 4.6 | +0.6 |
| geometry_reconstruction_12 | 4.0 | 4.4 | +0.4 |
| sphereDiffuse | 4.2 | 4.6 | +0.4 |
| pinhole_names2 | 4.4 | 4.6 | +0.2 |
| camera_forward_translation | 4.4 | 4.6 | +0.2 |
| yaw_pitch_roll | 4.4 | 4.6 | +0.2 |
| epipolar_3 | 4.2 | 4.2 | 0.0 |
| triangularization_stereo | 4.4 | 4.4 | 0.0 |
| office_vanishing_points_3 | 4.4 | 4.4 | 0.0 |
| ames_room | 4.2 | 4.2 | 0.0 |
| horizon_line | 4.6 | 4.6 | 0.0 |
| epipolar_geometry | 4.4 | 3.6 | **-0.8** |

**Only 1/26 multi-iteration figures ended up strictly worse than its first pass: `epipolar_geometry` (−0.8).** This is a net regression rate of 4% — lower even than the Gemini experiment (2/25 = 8%). Six figures went flat (no net change), and all others improved. The loop is very reliable for GPT-4.1 end-to-end.

---

## Patterns in the Third Pass

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_1 | 3.4 | 3.2 | **4.4** |
| stereocnn | 4.2 | 3.8 | **4.8** |
| ames_room | 4.2 | 3.4 | 4.2 |
| camera_forward_translation | 4.4 | 3.6 | **4.6** |
| geometry_reconstruction_12 | 4.0 | 3.4 | **4.4** |

Five figures pass through a worse state at iteration 2 before recovering. Three of them (`stereocnn`, `camera_forward_translation`, `geometry_reconstruction_12`) end up higher at iter 3 than iter 1 — so the dip is transitional, not fatal. `ames_room` merely returns to its starting score; the iter-2 degradation was entirely wasted.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| no_picture_on_a_wall_aina | 3.6 | **4.4** | 3.8 |

Only one figure peaked at iter 2 and regressed at iter 3 (vs. four such cases in the Gemini experiment). The orchestrator again had no mechanism to stop at the peak.

### Improved then flat at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| examples_3d_moving_points | 3.2 | 4.2 | 4.2 |
| flying_bird | 3.4 | 4.4 | 4.4 |
| basic_motion_point | 3.4 | 4.4 | 4.4 |
| sphereDiffuse | 4.2 | 4.6 | 4.6 |

Iter 3 changes nothing for these figures — it is a wasted pass that does neither harm nor good.

### Steady improvement across all three passes

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| streetgeons | 3.0 | 3.6 | **4.6** |
| vanishing_lines_and_planes | 3.2 | 4.0 | 4.2 |
| office_measuring_desk_sketch | 3.4 | 4.4 | 4.6 |
| camera_lateral_translation_flow | 3.8 | 4.4 | **4.8** |
| yaw_pitch_roll | 4.4 | 4.4 | 4.6 |
| pinhole_geometry2 | 4.0 | 4.0 | **4.6** |

Roughly a third of 3-iter figures show monotonically non-decreasing scores. `streetgeons` and `camera_lateral_translation_flow` are the strongest cases for running all three passes.

### Never recovered: net regression to final

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_geometry | 4.4 | 3.4 | 3.6 |

`epipolar_geometry` is the single failure: it started at 4.4, fell to 3.4 at iter 2, and only partially recovered to 3.6 at iter 3 — still 0.8 below its starting score. The critic flagged label clutter, camera-wrong, and scale-wrong failure modes that the generator was unable to resolve across all three passes.

---

## Notable Outlier: Broken First Pass

`camera_motion_field_rotation_three_f` scored **1.0 on iteration 1** — the lowest score in the experiment, indicating a near-total generation failure. The second pass recovered it to 4.4 (a +3.4 swing), earning an early stop. This is the strongest evidence that the iterative loop provides real insurance against catastrophic first-pass failures, though a 1.0 first-pass outcome suggests the planner or generator can occasionally produce non-renderable output that should ideally be detected and retried before spending a full critique pass on it.

---

## Summary

- **The first pass is already high for GPT-4.1**: most figures start at 3.2–4.4, compared to 2.0–4.4 in the Gemini experiment. This reduces the absolute improvement ceiling.
- **The second iteration is positive overall** (54% improve, 23% flat, 23% drop), but less uniformly beneficial than in the Gemini experiment (65% improve). Six figures drop at iter 2, though five of those six recover at iter 3.
- **The third iteration is broadly reliable** — only one figure (`no_picture_on_a_wall_aina`) peaked at iter 2 and was harmed by iter 3. For dip-and-recovery cases, iter 3 is essential.
- **Net regression rate is very low (1/26 = 4%)** — slightly better than the Gemini experiment's 8%. Few-shot prompting continues to stabilize the loop even with the higher-quality generator.
- **The orchestrator ran to 3 iterations in 63% of cases** — more selective than with the Gemini critic (81%), but still runs the full loop for nearly two-thirds of figures.
- **Key design implication**: given the many flat trajectories (no change at iter 2 or 3) and the wasted third passes for figures that plateau after iter 2, an early-stopping rule based on score *and* score-change (e.g., stop if iter N score ≥ 4.5 **or** if score did not change from iter N−1) could substantially reduce compute without sacrificing quality.
