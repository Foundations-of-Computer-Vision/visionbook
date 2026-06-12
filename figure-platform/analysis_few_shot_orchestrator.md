# Analysis: `few_shot_orchestrator`

## Overview

32 figures across 7 chapters. Generator: `gpt-5.5`. Critic: `gpt-4.1`. Critic version: `few_shot_critic`.

Average first-pass score: **4.11**. Average final score: **4.32**.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 8 | 25% |
| 2 (stopped early) | 9 | 28% |
| 3 (hit max) | 15 | 47% |

The orchestrator ran to 3 attempts in **47% of cases**. The 8 early-stop(s) at iteration 1: `axis_calibration_procedure`, `camera_lateral_translation_flow`, `geometry_reconstruction_12`, `horizon_line`, `office_measuring_desk_sketch`, `sphereDiffuse`, `vanishing_points`, `yaw_pitch_roll`.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 24 figures with at least 2 iterations (figures marked `→` exited after iteration 2):

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| epipolar_game_play | 3 | 4.4 → | **+1.4** |
| streetgeons | 3 | 4.2 | **+1.2** |
| camera_motion_field_rotation_three_f | 3.6 | 4.6 → | **+1** |
| spherePhongRoughness0.3 | 2.6 | 3 | +0.4 |
| ames_room | 4 | 4.4 → | +0.4 |
| stereocnn | 3.8 | 4.2 → | +0.4 |
| brdf | 4.2 | 4.4 | +0.2 |
| flying_bird | 4.4 | 4.6 | +0.2 |
| orthogonal_projection | 4.4 | 4.6 → | +0.2 |
| triangularization_stereo | 4.2 | 4.4 → | +0.2 |
| basic_motion_point | 4.4 | 4.4 | 0.0 |
| camera_lateral_translation | 1 | 1 | 0.0 |
| epipolar_geometry | 4.4 | 4.4 | 0.0 |
| examples_3d_moving_points | 4.4 | 4.4 | 0.0 |
| pinhole_geometry2 | 4.4 | 4.4 | 0.0 |
| similar_triangles2 | 4.4 | 4.4 | 0.0 |
| vanishing_lines_and_planes | 4.4 | 4.4 | 0.0 |
| camera_forward_translation | 4.6 | 4.6 → | 0.0 |
| epipolar_1 | 4.4 | 4.4 → | 0.0 |
| locating_a_3d_point | 4.4 | 4.4 → | 0.0 |
| epipolar_3 | 4.4 | 4.2 | -0.2 |
| pinhole_names2 | 4.4 | 4.2 | -0.2 |
| no_picture_on_a_wall_aina | 4.2 | 3.6 | -0.6 |
| office_vanishing_points_3 | 4.4 | 3.8 | -0.6 |

**10/24 improved, 10/24 flat, 4/24 dropped** at iteration 2.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| camera_lateral_translation | 1 | 4.4 | **+3.4** |
| spherePhongRoughness0.3 | 2.6 | 4.4 | **+1.8** |
| epipolar_game_play | 3 | 4.4 | **+1.4** |
| camera_motion_field_rotation_three_f | 3.6 | 4.6 | **+1** |
| ames_room | 4 | 4.4 | +0.4 |
| stereocnn | 3.8 | 4.2 | +0.4 |
| no_picture_on_a_wall_aina | 4.2 | 4.4 | +0.2 |
| similar_triangles2 | 4.4 | 4.6 | +0.2 |
| orthogonal_projection | 4.4 | 4.6 | +0.2 |
| triangularization_stereo | 4.2 | 4.4 | +0.2 |
| basic_motion_point | 4.4 | 4.4 | 0.0 |
| brdf | 4.2 | 4.2 | 0.0 |
| epipolar_3 | 4.4 | 4.4 | 0.0 |
| epipolar_geometry | 4.4 | 4.4 | 0.0 |
| flying_bird | 4.4 | 4.4 | 0.0 |
| pinhole_geometry2 | 4.4 | 4.4 | 0.0 |
| vanishing_lines_and_planes | 4.4 | 4.4 | 0.0 |
| camera_forward_translation | 4.6 | 4.6 | 0.0 |
| epipolar_1 | 4.4 | 4.4 | 0.0 |
| locating_a_3d_point | 4.4 | 4.4 | 0.0 |
| pinhole_names2 | 4.4 | 4.2 | -0.2 |
| streetgeons | 3 | 2.4 | -0.6 |
| examples_3d_moving_points | 4.4 | 3.6 | -0.8 |
| office_vanishing_points_3 | 4.4 | 3.6 | -0.8 |

**4/24 figure(s) ended up strictly worse than their first pass: `pinhole_names2` (-0.2), `streetgeons` (-0.6), `examples_3d_moving_points` (-0.8), `office_vanishing_points_3` (-0.8).** Net regression rate: 17%.

---

## Patterns in the Third Pass

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_3 | 4.4 | 4.2 | 4.4 |
| no_picture_on_a_wall_aina | 4.2 | 3.6 | 4.4 |

2 figure(s) passed through a worse state at iteration 2 before recovering at iteration 3.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| brdf | 4.2 | 4.4 | 4.2 |
| flying_bird | 4.4 | 4.6 | 4.4 |
| streetgeons | 3 | 4.2 | 2.4 |

3 figure(s) peaked at pass 2 with no mechanism to stop there.

### Steady improvement: both iter 2 and iter 3 helped

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| spherePhongRoughness0.3 | 2.6 | 3 | 4.4 |

1 figure(s) improved at both iter 2 and iter 3 — all three passes were useful.

### Flat at iter 2, improved at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| camera_lateral_translation | 1 | 1 | 4.4 |
| similar_triangles2 | 4.4 | 4.4 | 4.6 |

2 figure(s) showed no gain at iter 2 but improved at iter 3.

### Flat across all three passes

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| basic_motion_point | 4.4 | 4.4 | 4.4 |
| epipolar_geometry | 4.4 | 4.4 | 4.4 |
| pinhole_geometry2 | 4.4 | 4.4 | 4.4 |
| vanishing_lines_and_planes | 4.4 | 4.4 | 4.4 |

4 figure(s) showed no change across all iterations.

### Never recovered: net regression to final

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| examples_3d_moving_points | 4.4 | 4.4 | 3.6 |
| office_vanishing_points_3 | 4.4 | 3.8 | 3.6 |
| pinhole_names2 | 4.4 | 4.2 | 4.2 |
| streetgeons | 3 | 4.2 | 2.4 |

4 figure(s) ended iteration 3 below their iteration 1 score.

---

## Chapter Breakdown (average final score)

| Chapter | Figures | Avg Final Score |
|---|---|---|
| single_view_3d | 8 | 4.1 |
| stereo | 1 | 4.2 |
| optical_flow | 8 | 4.35 |
| imaging | 8 | 4.4 |
| 3d_scene_understanding | 5 | 4.4 |
| learning_3d | 1 | 4.6 |
| imaging_geometry | 1 | 4.6 |

---

## Summary

- **32 figures** evaluated; average first-pass score **4.11**, average final score **4.32**.
- **Orchestrator**: 47% of figures hit the 3-attempt ceiling.
- **Iter 1→2**: 10/24 improved (42%), 10 flat, 4 dropped.
- **Net regression** (final vs. iter 1): 4/24 = 17% ended below their first-pass score.
- **Dip-then-recovery**: 2 figure(s) degraded at iter 2 but recovered at iter 3.
- **Peaked at iter 2**: 3 figure(s) were harmed by a third pass they didn't need.
- **Flat at iter 2, gained at iter 3**: 2 figure(s) — iter 2 was the wasted pass.
- **Permanent regression**: 4 figure(s) never returned to their iter-1 score by iter 3.