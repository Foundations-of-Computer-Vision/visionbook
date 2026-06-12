# Analysis: `few_shot_benchmark_gemini3.5flash`

## Overview

31 figures across 7 chapters. Generator: `gpt-5.5`. Critic: `gemini-3.5-flash`. Critic version: `few_shot_critic`.

Average first-pass score: **3.83**. Average final score: **4.35**.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 5 | 16% |
| 2 (stopped early) | 1 | 3% |
| 3 (hit max) | 25 | 81% |

The orchestrator ran to 3 attempts in **81% of cases**. The 5 early-stop(s) at iteration 1: `ames_room`, `camera_motion_field_rotation_three_f`, `no_picture_on_a_wall_aina`, `office_vanishing_points_3`, `vanishing_lines_and_planes`.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 26 figures with at least 2 iterations (figures marked `→` exited after iteration 2):

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| camera_forward_translation | 2 | 4 | **+2** |
| geometry_reconstruction_12 | 2.6 | 4.6 | **+2** |
| epipolar_game_play | 4 | 5 → | **+1** |
| yaw_pitch_roll | 3.6 | 4.4 | +0.8 |
| horizon_line | 3.4 | 4 | +0.6 |
| office_measuring_desk_sketch | 3.8 | 4.4 | +0.6 |
| vanishing_points | 3.2 | 3.8 | +0.6 |
| flying_bird | 3.2 | 3.6 | +0.4 |
| locating_a_3d_point | 3 | 3.4 | +0.4 |
| pinhole_geometry2 | 3.8 | 4.2 | +0.4 |
| pinhole_names2 | 4.2 | 4.6 | +0.4 |
| streetgeons | 3 | 3.4 | +0.4 |
| triangularization_stereo | 3.2 | 3.6 | +0.4 |
| brdf | 4.2 | 4.4 | +0.2 |
| epipolar_3 | 4.2 | 4.4 | +0.2 |
| orthogonal_projection | 4.2 | 4.4 | +0.2 |
| similar_triangles2 | 4.2 | 4.4 | +0.2 |
| basic_motion_point | 4.2 | 4.2 | 0.0 |
| camera_lateral_translation | 3.6 | 3.6 | 0.0 |
| examples_3d_moving_points | 4.4 | 4.4 | 0.0 |
| axis_calibration_procedure | 3.8 | 3.6 | -0.2 |
| camera_lateral_translation_flow | 4.2 | 4 | -0.2 |
| epipolar_1 | 3.8 | 3.6 | -0.2 |
| sphereDiffuse | 4.4 | 4.2 | -0.2 |
| epipolar_geometry | 3.4 | 3 | -0.4 |
| stereocnn | 3.6 | 2.8 | -0.8 |

**17/26 improved, 3/26 flat, 6/26 dropped** at iteration 2.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| camera_forward_translation | 2 | 4 | **+2** |
| geometry_reconstruction_12 | 2.6 | 4.6 | **+2** |
| horizon_line | 3.4 | 5 | **+1.6** |
| streetgeons | 3 | 4.4 | **+1.4** |
| flying_bird | 3.2 | 4.4 | **+1.2** |
| triangularization_stereo | 3.2 | 4.4 | **+1.2** |
| vanishing_points | 3.2 | 4.2 | **+1** |
| epipolar_game_play | 4 | 5 | **+1** |
| locating_a_3d_point | 3 | 3.8 | +0.8 |
| axis_calibration_procedure | 3.8 | 4.4 | +0.6 |
| camera_lateral_translation | 3.6 | 4.2 | +0.6 |
| epipolar_geometry | 3.4 | 4 | +0.6 |
| office_measuring_desk_sketch | 3.8 | 4.4 | +0.6 |
| pinhole_geometry2 | 3.8 | 4.4 | +0.6 |
| sphereDiffuse | 4.4 | 5 | +0.6 |
| stereocnn | 3.6 | 4.2 | +0.6 |
| epipolar_1 | 3.8 | 4.2 | +0.4 |
| basic_motion_point | 4.2 | 4.4 | +0.2 |
| brdf | 4.2 | 4.4 | +0.2 |
| examples_3d_moving_points | 4.4 | 4.6 | +0.2 |
| orthogonal_projection | 4.2 | 4.4 | +0.2 |
| epipolar_3 | 4.2 | 4.2 | 0.0 |
| pinhole_names2 | 4.2 | 4.2 | 0.0 |
| yaw_pitch_roll | 3.6 | 3.6 | 0.0 |
| camera_lateral_translation_flow | 4.2 | 3.8 | -0.4 |
| similar_triangles2 | 4.2 | 3.2 | **-1** |

**2/26 figure(s) ended up strictly worse than their first pass: `camera_lateral_translation_flow` (-0.4), `similar_triangles2` (-1).** Net regression rate: 8%.

---

## Patterns in the Third Pass

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| axis_calibration_procedure | 3.8 | 3.6 | 4.4 |
| epipolar_1 | 3.8 | 3.6 | 4.2 |
| epipolar_geometry | 3.4 | 3 | 4 |
| sphereDiffuse | 4.4 | 4.2 | 5 |
| stereocnn | 3.6 | 2.8 | 4.2 |

5 figure(s) passed through a worse state at iteration 2 before recovering at iteration 3.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_3 | 4.2 | 4.4 | 4.2 |
| pinhole_names2 | 4.2 | 4.6 | 4.2 |
| similar_triangles2 | 4.2 | 4.4 | 3.2 |
| yaw_pitch_roll | 3.6 | 4.4 | 3.6 |

4 figure(s) peaked at pass 2 with no mechanism to stop there.

### Improved at iter 2, flat at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| brdf | 4.2 | 4.4 | 4.4 |
| camera_forward_translation | 2 | 4 | 4 |
| geometry_reconstruction_12 | 2.6 | 4.6 | 4.6 |
| office_measuring_desk_sketch | 3.8 | 4.4 | 4.4 |
| orthogonal_projection | 4.2 | 4.4 | 4.4 |

5 figure(s) improved at iter 2 then plateaued — iter 3 was a wasted pass.

### Steady improvement: both iter 2 and iter 3 helped

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| flying_bird | 3.2 | 3.6 | 4.4 |
| horizon_line | 3.4 | 4 | 5 |
| locating_a_3d_point | 3 | 3.4 | 3.8 |
| pinhole_geometry2 | 3.8 | 4.2 | 4.4 |
| streetgeons | 3 | 3.4 | 4.4 |
| triangularization_stereo | 3.2 | 3.6 | 4.4 |
| vanishing_points | 3.2 | 3.8 | 4.2 |

7 figure(s) improved at both iter 2 and iter 3 — all three passes were useful.

### Flat at iter 2, improved at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| basic_motion_point | 4.2 | 4.2 | 4.4 |
| camera_lateral_translation | 3.6 | 3.6 | 4.2 |
| examples_3d_moving_points | 4.4 | 4.4 | 4.6 |

3 figure(s) showed no gain at iter 2 but improved at iter 3.

### Never recovered: net regression to final

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| camera_lateral_translation_flow | 4.2 | 4 | 3.8 |
| similar_triangles2 | 4.2 | 4.4 | 3.2 |

2 figure(s) ended iteration 3 below their iteration 1 score.

---

## Chapter Breakdown (average final score)

| Chapter | Figures | Avg Final Score |
|---|---|---|
| stereo | 1 | 4.2 |
| optical_flow | 8 | 4.22 |
| imaging | 7 | 4.34 |
| 3d_scene_understanding | 5 | 4.36 |
| single_view_3d | 8 | 4.4 |
| learning_3d | 1 | 4.6 |
| imaging_geometry | 1 | 5.0 |

---

## Summary

- **31 figures** evaluated; average first-pass score **3.83**, average final score **4.35**.
- **Orchestrator**: 81% of figures hit the 3-attempt ceiling.
- **Iter 1→2**: 17/26 improved (65%), 3 flat, 6 dropped.
- **Net regression** (final vs. iter 1): 2/26 = 8% ended below their first-pass score.
- **Dip-then-recovery**: 5 figure(s) degraded at iter 2 but recovered at iter 3.
- **Peaked at iter 2**: 4 figure(s) were harmed by a third pass they didn't need.
- **Plateaued after iter 2**: 5 figure(s) — iter 3 added nothing.
- **Flat at iter 2, gained at iter 3**: 3 figure(s) — iter 2 was the wasted pass.
- **Permanent regression**: 2 figure(s) never returned to their iter-1 score by iter 3.