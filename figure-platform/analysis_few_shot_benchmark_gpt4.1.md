# Analysis: `few_shot_benchmark_gpt4.1`

## Overview

32 figures across 7 chapters. Generator: `gpt-5.5`. Critic: `gpt-4.1`. Critic version: `few_shot_critic`.

Average first-pass score: **3.93**. Average final score: **4.44**.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 6 | 19% |
| 2 (stopped early) | 6 | 19% |
| 3 (hit max) | 20 | 62% |

The orchestrator ran to 3 attempts in **62% of cases**. The 6 early-stop(s) at iteration 1: `axis_calibration_procedure`, `epipolar_game_play`, `locating_a_3d_point`, `orthogonal_projection`, `similar_triangles2`, `vanishing_points`.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 26 figures with at least 2 iterations (figures marked `→` exited after iteration 2):

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 1 | 4.4 → | **+3.4** |
| basic_motion_point | 3.4 | 4.4 | **+1** |
| examples_3d_moving_points | 3.2 | 4.2 | **+1** |
| flying_bird | 3.4 | 4.4 | **+1** |
| office_measuring_desk_sketch | 3.4 | 4.4 | **+1** |
| no_picture_on_a_wall_aina | 3.6 | 4.4 | +0.8 |
| vanishing_lines_and_planes | 3.2 | 4 | +0.8 |
| spherePhongRoughness0.3 | 3.8 | 4.6 → | +0.8 |
| camera_lateral_translation_flow | 3.8 | 4.4 | +0.6 |
| streetgeons | 3 | 3.6 | +0.6 |
| brdf | 4.2 | 4.8 → | +0.6 |
| camera_lateral_translation | 3.8 | 4.4 → | +0.6 |
| sphereDiffuse | 4.2 | 4.6 | +0.4 |
| pinhole_names2 | 4.4 | 4.6 → | +0.2 |
| epipolar_3 | 4.2 | 4.2 | 0.0 |
| office_vanishing_points_3 | 4.4 | 4.4 | 0.0 |
| pinhole_geometry2 | 4 | 4 | 0.0 |
| triangularization_stereo | 4.4 | 4.4 | 0.0 |
| yaw_pitch_roll | 4.4 | 4.4 | 0.0 |
| horizon_line | 4.6 | 4.6 → | 0.0 |
| epipolar_1 | 3.4 | 3.2 | -0.2 |
| stereocnn | 4.2 | 3.8 | -0.4 |
| geometry_reconstruction_12 | 4 | 3.4 | -0.6 |
| ames_room | 4.2 | 3.4 | -0.8 |
| camera_forward_translation | 4.4 | 3.6 | -0.8 |
| epipolar_geometry | 4.4 | 3.4 | **-1** |

**14/26 improved, 6/26 flat, 6/26 dropped** at iteration 2.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 1 | 4.4 | **+3.4** |
| streetgeons | 3 | 4.6 | **+1.6** |
| office_measuring_desk_sketch | 3.4 | 4.6 | **+1.2** |
| basic_motion_point | 3.4 | 4.4 | **+1** |
| camera_lateral_translation_flow | 3.8 | 4.8 | **+1** |
| epipolar_1 | 3.4 | 4.4 | **+1** |
| examples_3d_moving_points | 3.2 | 4.2 | **+1** |
| flying_bird | 3.4 | 4.4 | **+1** |
| vanishing_lines_and_planes | 3.2 | 4.2 | **+1** |
| spherePhongRoughness0.3 | 3.8 | 4.6 | +0.8 |
| pinhole_geometry2 | 4 | 4.6 | +0.6 |
| stereocnn | 4.2 | 4.8 | +0.6 |
| brdf | 4.2 | 4.8 | +0.6 |
| camera_lateral_translation | 3.8 | 4.4 | +0.6 |
| geometry_reconstruction_12 | 4 | 4.4 | +0.4 |
| sphereDiffuse | 4.2 | 4.6 | +0.4 |
| camera_forward_translation | 4.4 | 4.6 | +0.2 |
| no_picture_on_a_wall_aina | 3.6 | 3.8 | +0.2 |
| yaw_pitch_roll | 4.4 | 4.6 | +0.2 |
| pinhole_names2 | 4.4 | 4.6 | +0.2 |
| ames_room | 4.2 | 4.2 | 0.0 |
| epipolar_3 | 4.2 | 4.2 | 0.0 |
| office_vanishing_points_3 | 4.4 | 4.4 | 0.0 |
| triangularization_stereo | 4.4 | 4.4 | 0.0 |
| horizon_line | 4.6 | 4.6 | 0.0 |
| epipolar_geometry | 4.4 | 3.6 | -0.8 |

**1/26 figure(s) ended up strictly worse than their first pass: `epipolar_geometry` (-0.8).** Net regression rate: 4%.

---

## Patterns in the Third Pass

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| ames_room | 4.2 | 3.4 | 4.2 |
| camera_forward_translation | 4.4 | 3.6 | 4.6 |
| epipolar_1 | 3.4 | 3.2 | 4.4 |
| epipolar_geometry | 4.4 | 3.4 | 3.6 |
| geometry_reconstruction_12 | 4 | 3.4 | 4.4 |
| stereocnn | 4.2 | 3.8 | 4.8 |

6 figure(s) passed through a worse state at iteration 2 before recovering at iteration 3.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| no_picture_on_a_wall_aina | 3.6 | 4.4 | 3.8 |

1 figure(s) peaked at pass 2 with no mechanism to stop there.

### Improved at iter 2, flat at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| basic_motion_point | 3.4 | 4.4 | 4.4 |
| examples_3d_moving_points | 3.2 | 4.2 | 4.2 |
| flying_bird | 3.4 | 4.4 | 4.4 |
| sphereDiffuse | 4.2 | 4.6 | 4.6 |

4 figure(s) improved at iter 2 then plateaued — iter 3 was a wasted pass.

### Steady improvement: both iter 2 and iter 3 helped

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| camera_lateral_translation_flow | 3.8 | 4.4 | 4.8 |
| office_measuring_desk_sketch | 3.4 | 4.4 | 4.6 |
| streetgeons | 3 | 3.6 | 4.6 |
| vanishing_lines_and_planes | 3.2 | 4 | 4.2 |

4 figure(s) improved at both iter 2 and iter 3 — all three passes were useful.

### Flat at iter 2, improved at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| pinhole_geometry2 | 4 | 4 | 4.6 |
| yaw_pitch_roll | 4.4 | 4.4 | 4.6 |

2 figure(s) showed no gain at iter 2 but improved at iter 3.

### Flat across all three passes

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_3 | 4.2 | 4.2 | 4.2 |
| office_vanishing_points_3 | 4.4 | 4.4 | 4.4 |
| triangularization_stereo | 4.4 | 4.4 | 4.4 |

3 figure(s) showed no change across all iterations.

### Never recovered: net regression to final

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| epipolar_geometry | 4.4 | 3.4 | 3.6 |

1 figure(s) ended iteration 3 below their iteration 1 score.

---

## Chapter Breakdown (average final score)

| Chapter | Figures | Avg Final Score |
|---|---|---|
| 3d_scene_understanding | 5 | 4.16 |
| learning_3d | 1 | 4.4 |
| single_view_3d | 8 | 4.42 |
| optical_flow | 8 | 4.47 |
| imaging | 8 | 4.53 |
| imaging_geometry | 1 | 4.6 |
| stereo | 1 | 4.8 |

---

## Summary

- **32 figures** evaluated; average first-pass score **3.93**, average final score **4.44**.
- **Orchestrator**: 62% of figures hit the 3-attempt ceiling.
- **Iter 1→2**: 14/26 improved (54%), 6 flat, 6 dropped.
- **Net regression** (final vs. iter 1): 1/26 = 4% ended below their first-pass score.
- **Dip-then-recovery**: 6 figure(s) degraded at iter 2 but recovered at iter 3.
- **Peaked at iter 2**: 1 figure(s) were harmed by a third pass they didn't need.
- **Plateaued after iter 2**: 4 figure(s) — iter 3 added nothing.
- **Flat at iter 2, gained at iter 3**: 2 figure(s) — iter 2 was the wasted pass.
- **Permanent regression**: 1 figure(s) never returned to their iter-1 score by iter 3.