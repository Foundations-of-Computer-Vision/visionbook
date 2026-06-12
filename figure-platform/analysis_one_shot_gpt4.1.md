# Analysis: `one_shot_gpt4.1`

## Overview

32 figures across 7 chapters. Generator: `gpt-5.5`. Critic: `gpt-4.1`. Critic version: `few_shot_critic`.

Average first-pass score: **4.08**. Average final score: **4.11**.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 0 | 0% |
| 2 (stopped early) | 0 | 0% |
| 3 (hit max) | 32 | 100% |

The orchestrator ran to 3 attempts in **100% of cases**. No figures exited after a single pass.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 32 figures with at least 2 iterations (figures marked `→` exited after iteration 2):

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| examples_3d_moving_points | 3 | 4.2 | **+1.2** |
| camera_lateral_translation | 3.6 | 4.6 | **+1** |
| ames_room | 3.4 | 4.2 | +0.8 |
| flying_bird | 3.6 | 4.4 | +0.8 |
| spherePhongRoughness0.3 | 4 | 4.8 | +0.8 |
| streetgeons | 3 | 3.6 | +0.6 |
| geometry_reconstruction_12 | 4 | 4.4 | +0.4 |
| office_vanishing_points_3 | 3.8 | 4.2 | +0.4 |
| similar_triangles2 | 4.2 | 4.6 | +0.4 |
| brdf | 4.4 | 4.6 | +0.2 |
| camera_motion_field_rotation_three_f | 4.2 | 4.4 | +0.2 |
| epipolar_game_play | 4.2 | 4.4 | +0.2 |
| vanishing_points | 4.2 | 4.4 | +0.2 |
| yaw_pitch_roll | 4.4 | 4.6 | +0.2 |
| basic_motion_point | 4.4 | 4.4 | 0.0 |
| camera_forward_translation | 4.6 | 4.6 | 0.0 |
| camera_lateral_translation_flow | 4.4 | 4.4 | 0.0 |
| epipolar_1 | 4.4 | 4.4 | 0.0 |
| horizon_line | 4.4 | 4.4 | 0.0 |
| locating_a_3d_point | 4.4 | 4.4 | 0.0 |
| orthogonal_projection | 4.4 | 4.4 | 0.0 |
| pinhole_geometry2 | 4.4 | 4.4 | 0.0 |
| stereocnn | 4.4 | 4.4 | 0.0 |
| vanishing_lines_and_planes | 4.4 | 4.4 | 0.0 |
| epipolar_3 | 4.6 | 4.4 | -0.2 |
| no_picture_on_a_wall_aina | 3.4 | 3.2 | -0.2 |
| office_measuring_desk_sketch | 4.4 | 4.2 | -0.2 |
| pinhole_names2 | 4.4 | 4.2 | -0.2 |
| sphereDiffuse | 2.6 | 2.4 | -0.2 |
| axis_calibration_procedure | 4.2 | 3.8 | -0.4 |
| epipolar_geometry | 4.4 | 4 | -0.4 |
| triangularization_stereo | 4.4 | 3.4 | **-1** |

**14/32 improved, 10/32 flat, 8/32 dropped** at iteration 2.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| examples_3d_moving_points | 3 | 4.4 | **+1.4** |
| no_picture_on_a_wall_aina | 3.4 | 4.4 | **+1** |
| spherePhongRoughness0.3 | 4 | 5 | **+1** |
| ames_room | 3.4 | 4.2 | +0.8 |
| flying_bird | 3.6 | 4.4 | +0.8 |
| office_vanishing_points_3 | 3.8 | 4.4 | +0.6 |
| axis_calibration_procedure | 4.2 | 4.6 | +0.4 |
| geometry_reconstruction_12 | 4 | 4.4 | +0.4 |
| office_measuring_desk_sketch | 4.4 | 4.6 | +0.2 |
| streetgeons | 3 | 3.2 | +0.2 |
| vanishing_points | 4.2 | 4.4 | +0.2 |
| yaw_pitch_roll | 4.4 | 4.6 | +0.2 |
| basic_motion_point | 4.4 | 4.4 | 0.0 |
| brdf | 4.4 | 4.4 | 0.0 |
| camera_forward_translation | 4.6 | 4.6 | 0.0 |
| epipolar_1 | 4.4 | 4.4 | 0.0 |
| epipolar_geometry | 4.4 | 4.4 | 0.0 |
| horizon_line | 4.4 | 4.4 | 0.0 |
| locating_a_3d_point | 4.4 | 4.4 | 0.0 |
| orthogonal_projection | 4.4 | 4.4 | 0.0 |
| pinhole_names2 | 4.4 | 4.4 | 0.0 |
| similar_triangles2 | 4.2 | 4.2 | 0.0 |
| sphereDiffuse | 2.6 | 2.6 | 0.0 |
| stereocnn | 4.4 | 4.4 | 0.0 |
| triangularization_stereo | 4.4 | 4.4 | 0.0 |
| epipolar_3 | 4.6 | 4.4 | -0.2 |
| camera_motion_field_rotation_three_f | 4.2 | 3.8 | -0.4 |
| camera_lateral_translation | 3.6 | 3 | -0.6 |
| vanishing_lines_and_planes | 4.4 | 3.8 | -0.6 |
| camera_lateral_translation_flow | 4.4 | 3.6 | -0.8 |
| pinhole_geometry2 | 4.4 | 3.2 | **-1.2** |
| epipolar_game_play | 4.2 | 1.6 | **-2.6** |

**7/32 figure(s) ended up strictly worse than their first pass: `epipolar_3` (-0.2), `camera_motion_field_rotation_three_f` (-0.4), `camera_lateral_translation` (-0.6), `vanishing_lines_and_planes` (-0.6), `camera_lateral_translation_flow` (-0.8), `pinhole_geometry2` (-1.2), `epipolar_game_play` (-2.6).** Net regression rate: 22%.

---

## Patterns in the Third Pass

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| axis_calibration_procedure | 4.2 | 3.8 | 4.6 |
| epipolar_geometry | 4.4 | 4 | 4.4 |
| no_picture_on_a_wall_aina | 3.4 | 3.2 | 4.4 |
| office_measuring_desk_sketch | 4.4 | 4.2 | 4.6 |
| pinhole_names2 | 4.4 | 4.2 | 4.4 |
| sphereDiffuse | 2.6 | 2.4 | 2.6 |
| triangularization_stereo | 4.4 | 3.4 | 4.4 |

7 figure(s) passed through a worse state at iteration 2 before recovering at iteration 3.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| brdf | 4.4 | 4.6 | 4.4 |
| camera_lateral_translation | 3.6 | 4.6 | 3 |
| camera_motion_field_rotation_three_f | 4.2 | 4.4 | 3.8 |
| epipolar_game_play | 4.2 | 4.4 | 1.6 |
| similar_triangles2 | 4.2 | 4.6 | 4.2 |
| streetgeons | 3 | 3.6 | 3.2 |

6 figure(s) peaked at pass 2 with no mechanism to stop there.

### Improved at iter 2, flat at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| ames_room | 3.4 | 4.2 | 4.2 |
| flying_bird | 3.6 | 4.4 | 4.4 |
| geometry_reconstruction_12 | 4 | 4.4 | 4.4 |
| vanishing_points | 4.2 | 4.4 | 4.4 |
| yaw_pitch_roll | 4.4 | 4.6 | 4.6 |

5 figure(s) improved at iter 2 then plateaued — iter 3 was a wasted pass.

### Steady improvement: both iter 2 and iter 3 helped

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| examples_3d_moving_points | 3 | 4.2 | 4.4 |
| office_vanishing_points_3 | 3.8 | 4.2 | 4.4 |
| spherePhongRoughness0.3 | 4 | 4.8 | 5 |

3 figure(s) improved at both iter 2 and iter 3 — all three passes were useful.

### Flat across all three passes

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| basic_motion_point | 4.4 | 4.4 | 4.4 |
| camera_forward_translation | 4.6 | 4.6 | 4.6 |
| epipolar_1 | 4.4 | 4.4 | 4.4 |
| horizon_line | 4.4 | 4.4 | 4.4 |
| locating_a_3d_point | 4.4 | 4.4 | 4.4 |
| orthogonal_projection | 4.4 | 4.4 | 4.4 |
| stereocnn | 4.4 | 4.4 | 4.4 |

7 figure(s) showed no change across all iterations.

### Never recovered: net regression to final

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| camera_lateral_translation | 3.6 | 4.6 | 3 |
| camera_lateral_translation_flow | 4.4 | 4.4 | 3.6 |
| camera_motion_field_rotation_three_f | 4.2 | 4.4 | 3.8 |
| epipolar_3 | 4.6 | 4.4 | 4.4 |
| epipolar_game_play | 4.2 | 4.4 | 1.6 |
| pinhole_geometry2 | 4.4 | 4.4 | 3.2 |
| vanishing_lines_and_planes | 4.4 | 4.4 | 3.8 |

7 figure(s) ended iteration 3 below their iteration 1 score.

---

## Chapter Breakdown (average final score)

| Chapter | Figures | Avg Final Score |
|---|---|---|
| 3d_scene_understanding | 5 | 3.84 |
| imaging | 8 | 4.08 |
| optical_flow | 8 | 4.1 |
| single_view_3d | 8 | 4.2 |
| learning_3d | 1 | 4.4 |
| imaging_geometry | 1 | 4.4 |
| stereo | 1 | 4.4 |

---

## Summary

- **32 figures** evaluated; average first-pass score **4.08**, average final score **4.11**.
- **Orchestrator**: 100% of figures hit the 3-attempt ceiling.
- **Iter 1→2**: 14/32 improved (44%), 10 flat, 8 dropped.
- **Net regression** (final vs. iter 1): 7/32 = 22% ended below their first-pass score.
- **Dip-then-recovery**: 7 figure(s) degraded at iter 2 but recovered at iter 3.
- **Peaked at iter 2**: 6 figure(s) were harmed by a third pass they didn't need.
- **Plateaued after iter 2**: 5 figure(s) — iter 3 added nothing.
- **Permanent regression**: 7 figure(s) never returned to their iter-1 score by iter 3.