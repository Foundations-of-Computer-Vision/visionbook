# Analysis: `few_shot_planner`

## Overview

32 figures across 7 chapters. Generator: `gpt-5.5`. Critic: `gpt-4.1`. Critic version: `few_shot_critic`.

Average first-pass score: **3.98**. Average final score: **4.29**.

---

## Orchestrator Attempt Distribution

| Iterations used | Count | % |
|---|---|---|
| 1 (stopped early) | 0 | 0% |
| 2 (stopped early) | 1 | 3% |
| 3 (hit max) | 31 | 97% |

The orchestrator ran to 3 attempts in **97% of cases**. No figures exited after a single pass.

---

## Iteration 1 vs. Iteration 2 (first vs. second pass)

For the 32 figures with at least 2 iterations (figures marked `→` exited after iteration 2):

| Figure | Iter 1 | Iter 2 | Δ |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 2.8 | 4.4 | **+1.6** |
| examples_3d_moving_points | 3.2 | 4.4 | **+1.2** |
| epipolar_game_play | 3.4 | 4.4 | **+1** |
| flying_bird | 3.4 | 4.4 | **+1** |
| no_picture_on_a_wall_aina | 3.4 | 4.4 | **+1** |
| basic_motion_point | 3.6 | 4.4 | +0.8 |
| sphereDiffuse | 3 | 3.8 | +0.8 |
| yaw_pitch_roll | 4.4 | 5 → | +0.6 |
| horizon_line | 4.2 | 4.6 | +0.4 |
| office_vanishing_points_3 | 4 | 4.4 | +0.4 |
| similar_triangles2 | 4.2 | 4.6 | +0.4 |
| epipolar_1 | 4.2 | 4.4 | +0.2 |
| orthogonal_projection | 4.4 | 4.6 | +0.2 |
| camera_lateral_translation | 1 | 1 | 0.0 |
| epipolar_3 | 4.4 | 4.4 | 0.0 |
| epipolar_geometry | 4.4 | 4.4 | 0.0 |
| pinhole_geometry2 | 4.2 | 4.2 | 0.0 |
| vanishing_lines_and_planes | 3.4 | 3.4 | 0.0 |
| vanishing_points | 4.4 | 4.4 | 0.0 |
| camera_forward_translation | 4.6 | 4.4 | -0.2 |
| office_measuring_desk_sketch | 4.6 | 4.4 | -0.2 |
| spherePhongRoughness0.3 | 4.6 | 4.4 | -0.2 |
| axis_calibration_procedure | 4.4 | 4 | -0.4 |
| stereocnn | 4.4 | 4 | -0.4 |
| triangularization_stereo | 4.4 | 4 | -0.4 |
| brdf | 4.4 | 3.8 | -0.6 |
| pinhole_names2 | 4.4 | 3.8 | -0.6 |
| camera_lateral_translation_flow | 4.6 | 3.8 | -0.8 |
| locating_a_3d_point | 4.4 | 3.6 | -0.8 |
| ames_room | 4.4 | 3.4 | **-1** |
| geometry_reconstruction_12 | 4.2 | 2.8 | **-1.4** |
| streetgeons | 4 | 2.6 | **-1.4** |

**13/32 improved, 6/32 flat, 13/32 dropped** at iteration 2.

---

## Score Regression: Final Score vs. Iter 1

| Figure | Iter 1 | Final | Net Δ |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 2.8 | 4.4 | **+1.6** |
| sphereDiffuse | 3 | 4.6 | **+1.6** |
| basic_motion_point | 3.6 | 4.6 | **+1** |
| epipolar_game_play | 3.4 | 4.4 | **+1** |
| examples_3d_moving_points | 3.2 | 4.2 | **+1** |
| flying_bird | 3.4 | 4.4 | **+1** |
| no_picture_on_a_wall_aina | 3.4 | 4.4 | **+1** |
| office_vanishing_points_3 | 4 | 5 | **+1** |
| vanishing_lines_and_planes | 3.4 | 4.4 | **+1** |
| yaw_pitch_roll | 4.4 | 5 | +0.6 |
| brdf | 4.4 | 4.6 | +0.2 |
| epipolar_1 | 4.2 | 4.4 | +0.2 |
| horizon_line | 4.2 | 4.4 | +0.2 |
| similar_triangles2 | 4.2 | 4.4 | +0.2 |
| streetgeons | 4 | 4.2 | +0.2 |
| triangularization_stereo | 4.4 | 4.6 | +0.2 |
| ames_room | 4.4 | 4.4 | 0.0 |
| camera_forward_translation | 4.6 | 4.6 | 0.0 |
| camera_lateral_translation | 1 | 1 | 0.0 |
| epipolar_geometry | 4.4 | 4.4 | 0.0 |
| geometry_reconstruction_12 | 4.2 | 4.2 | 0.0 |
| locating_a_3d_point | 4.4 | 4.4 | 0.0 |
| orthogonal_projection | 4.4 | 4.4 | 0.0 |
| vanishing_points | 4.4 | 4.4 | 0.0 |
| axis_calibration_procedure | 4.4 | 4.2 | -0.2 |
| camera_lateral_translation_flow | 4.6 | 4.4 | -0.2 |
| epipolar_3 | 4.4 | 4.2 | -0.2 |
| pinhole_geometry2 | 4.2 | 4 | -0.2 |
| pinhole_names2 | 4.4 | 4.2 | -0.2 |
| stereocnn | 4.4 | 4.2 | -0.2 |
| office_measuring_desk_sketch | 4.6 | 4.2 | -0.4 |
| spherePhongRoughness0.3 | 4.6 | 4.2 | -0.4 |

**8/32 figure(s) ended up strictly worse than their first pass: `axis_calibration_procedure` (-0.2), `camera_lateral_translation_flow` (-0.2), `epipolar_3` (-0.2), `pinhole_geometry2` (-0.2), `pinhole_names2` (-0.2), `stereocnn` (-0.2), `office_measuring_desk_sketch` (-0.4), `spherePhongRoughness0.3` (-0.4).** Net regression rate: 25%.

---

## Patterns in the Third Pass

### Dip-then-recovery (iter 2 bad, iter 3 recovers)

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| ames_room | 4.4 | 3.4 | 4.4 |
| axis_calibration_procedure | 4.4 | 4 | 4.2 |
| brdf | 4.4 | 3.8 | 4.6 |
| camera_forward_translation | 4.6 | 4.4 | 4.6 |
| camera_lateral_translation_flow | 4.6 | 3.8 | 4.4 |
| geometry_reconstruction_12 | 4.2 | 2.8 | 4.2 |
| locating_a_3d_point | 4.4 | 3.6 | 4.4 |
| pinhole_names2 | 4.4 | 3.8 | 4.2 |
| stereocnn | 4.4 | 4 | 4.2 |
| streetgeons | 4 | 2.6 | 4.2 |
| triangularization_stereo | 4.4 | 4 | 4.6 |

11 figure(s) passed through a worse state at iteration 2 before recovering at iteration 3.

### Peaked at iter 2, iter 3 regresses

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| examples_3d_moving_points | 3.2 | 4.4 | 4.2 |
| horizon_line | 4.2 | 4.6 | 4.4 |
| orthogonal_projection | 4.4 | 4.6 | 4.4 |
| similar_triangles2 | 4.2 | 4.6 | 4.4 |

4 figure(s) peaked at pass 2 with no mechanism to stop there.

### Improved at iter 2, flat at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| camera_motion_field_rotation_three_f | 2.8 | 4.4 | 4.4 |
| epipolar_1 | 4.2 | 4.4 | 4.4 |
| epipolar_game_play | 3.4 | 4.4 | 4.4 |
| flying_bird | 3.4 | 4.4 | 4.4 |
| no_picture_on_a_wall_aina | 3.4 | 4.4 | 4.4 |

5 figure(s) improved at iter 2 then plateaued — iter 3 was a wasted pass.

### Steady improvement: both iter 2 and iter 3 helped

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| basic_motion_point | 3.6 | 4.4 | 4.6 |
| office_vanishing_points_3 | 4 | 4.4 | 5 |
| sphereDiffuse | 3 | 3.8 | 4.6 |

3 figure(s) improved at both iter 2 and iter 3 — all three passes were useful.

### Flat at iter 2, improved at iter 3

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| vanishing_lines_and_planes | 3.4 | 3.4 | 4.4 |

1 figure(s) showed no gain at iter 2 but improved at iter 3.

### Flat across all three passes

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| camera_lateral_translation | 1 | 1 | 1 |
| epipolar_geometry | 4.4 | 4.4 | 4.4 |
| vanishing_points | 4.4 | 4.4 | 4.4 |

3 figure(s) showed no change across all iterations.

### Never recovered: net regression to final

| Figure | Iter 1 | Iter 2 | Iter 3 |
|---|---|---|---|
| axis_calibration_procedure | 4.4 | 4 | 4.2 |
| camera_lateral_translation_flow | 4.6 | 3.8 | 4.4 |
| epipolar_3 | 4.4 | 4.4 | 4.2 |
| office_measuring_desk_sketch | 4.6 | 4.4 | 4.2 |
| pinhole_geometry2 | 4.2 | 4.2 | 4 |
| pinhole_names2 | 4.4 | 3.8 | 4.2 |
| spherePhongRoughness0.3 | 4.6 | 4.4 | 4.2 |
| stereocnn | 4.4 | 4 | 4.2 |

8 figure(s) ended iteration 3 below their iteration 1 score.

---

## Chapter Breakdown (average final score)

| Chapter | Figures | Avg Final Score |
|---|---|---|
| optical_flow | 8 | 4.08 |
| learning_3d | 1 | 4.2 |
| stereo | 1 | 4.2 |
| imaging | 8 | 4.35 |
| single_view_3d | 8 | 4.4 |
| 3d_scene_understanding | 5 | 4.4 |
| imaging_geometry | 1 | 4.4 |

---

## Summary

- **32 figures** evaluated; average first-pass score **3.98**, average final score **4.29**.
- **Orchestrator**: 97% of figures hit the 3-attempt ceiling.
- **Iter 1→2**: 13/32 improved (41%), 6 flat, 13 dropped.
- **Net regression** (final vs. iter 1): 8/32 = 25% ended below their first-pass score.
- **Dip-then-recovery**: 11 figure(s) degraded at iter 2 but recovered at iter 3.
- **Peaked at iter 2**: 4 figure(s) were harmed by a third pass they didn't need.
- **Plateaued after iter 2**: 5 figure(s) — iter 3 added nothing.
- **Flat at iter 2, gained at iter 3**: 1 figure(s) — iter 2 was the wasted pass.
- **Permanent regression**: 8 figure(s) never returned to their iter-1 score by iter 3.