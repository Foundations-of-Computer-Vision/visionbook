/**
 * figure_loop.js — orchestrates the complete plan → generate → critique → feedback loop
 *
 * Implements an auto-iterative workflow:
 *   1. PLAN: Generate interaction blueprint
 *   2. GENERATE: Create 3D code from plan
 *   3. CRITIQUE: Evaluate with critic (5 metrics + failure modes + feedback)
 *   4. DECIDE: Fix plan vs. refine generation based on critic's next_step
 *   5. LOOP or EXIT
 *
 * Tracks all iterations for audit trail and debugging.
 */

const { planForFigure, refinePlan } = require('./planner');
const { generateCode } = require('./generation');
const { evaluateHtmlWithCritic } = require('./critic');

/**
 * Main loop orchestrator.
 * Returns a full audit trail of all iterations.
 *
 * @param {object} opts
 * @param {string} opts.figureStem - e.g. "brdf"
 * @param {string} opts.chapterName - e.g. "imaging"
 * @param {object} opts.imageData - { base64, mediaType }
 * @param {string} opts.scaffold - base HTML scaffold
 * @param {string} opts.sourceBase64 - original figure image (for critic)
 * @param {string} opts.sourceMediaType - "image/png"
 * @param {number} [opts.maxAttempts=3] - max iterations before giving up
 * @param {number} [opts.passThreshold=4.0] - overall_average score needed to pass
 * @param {string} [opts.plannerModel='gpt-4o']
 * @param {string} [opts.generatorModel='gpt-4o']
 * @param {string} [opts.criticModel='claude-opus-4.7']
 * @returns {object} - complete loop state and results
 */
async function runFigureLoop(opts) {
    const {
        figureStem,
        chapterName,
        imageData,
        scaffold,
        sourceBase64,
        sourceMediaType = 'image/png',
        maxAttempts = 3,
        passThreshold = 4.0,
        plannerModel = 'gpt-4o',
        generatorModel = 'gpt-4o',
        criticModel = 'claude-opus-4.7',
    } = opts;

    if (!figureStem) throw new Error('figureStem is required');
    if (!scaffold) throw new Error('scaffold is required');
    if (!imageData?.base64 || !imageData?.mediaType) throw new Error('imageData.base64 and imageData.mediaType are required');
    if (!sourceBase64) throw new Error('sourceBase64 (original figure image) is required');

    // Initialize loop state
    const loopState = {
        figureStem,
        chapterName: chapterName || null,
        status: 'planning',                    // planning | generating | critiquing | reviewing | passed | failed_max_attempts | failed_unrecoverable
        currentPlan: null,
        currentHtml: null,
        currentEvaluation: null,
        currentFeedback: null,
        attempts: [],                          // Full audit trail of each iteration
        bestAttempt: null,                     // Iteration with highest overall_average score
        bestScore: 0,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: INITIAL PLAN
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`Starting loop for ${figureStem}`);
    loopState.status = 'planning';

    try {
        loopState.currentPlan = await planForFigure(figureStem, chapterName, imageData, plannerModel);
        console.log(`Plan created`, { elements: loopState.currentPlan.interactionPlan?.elements?.length || 0 });
    } catch (e) {
        loopState.status = 'failed_planning';
        loopState.attempts.push({
            iteration: 0,
            step: 'plan',
            status: 'error',
            error: e.message,
        });
        console.log(`PLAN FAILED: ${e.message}`);
        return loopState;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MAIN LOOP: GENERATE → CRITIQUE → REVIEW → DECIDE
    // ─────────────────────────────────────────────────────────────────────────
    for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
        const attempt = {
            iteration: attemptNum,
            step: null,
            plan: loopState.currentPlan,
            html: null,
            evaluation: null,
            feedback: null,
            status: 'in-progress',
        };

        // ───── GENERATE ─────
        console.log(`[Attempt ${attemptNum}/${maxAttempts}] Generating...`);
        loopState.status = 'generating';
        attempt.step = 'generate';

        try {
            loopState.currentHtml = await generateCode({
                scaffold,
                plan: loopState.currentPlan,
                prevHtml: loopState.attempts[attemptNum - 2]?.html || null,
                evaluation: loopState.attempts[attemptNum - 2]?.evaluation || null,
                modelId: generatorModel,
                mediaType: imageData.mediaType,
                base64: imageData.base64,
            });
            attempt.html = loopState.currentHtml;
            console.log(`Generated HTML (${loopState.currentHtml.length} chars)`);
        } catch (e) {
            attempt.status = 'error';
            attempt.error = e.message;
            loopState.attempts.push(attempt);
            console.log(`GENERATION FAILED: ${e.message}`);
            loopState.status = 'failed_generation';
            break;
        }

        // ───── CRITIQUE ─────
        console.log(`Evaluating...`);
        loopState.status = 'critiquing';

        try {
            loopState.currentEvaluation = await evaluateHtmlWithCritic({
                html: loopState.currentHtml,
                evalImage: sourceBase64,
                evalMediaType: sourceMediaType,
                model: criticModel,
            });
            attempt.evaluation = loopState.currentEvaluation;

            console.log(`Critic scores`, {
                overall: loopState.currentEvaluation.overall_average,
                failures: (loopState.currentEvaluation.failure_modes || []).length,
            });

            // Track best attempt
            if (loopState.currentEvaluation.overall_average > loopState.bestScore) {
                loopState.bestScore = loopState.currentEvaluation.overall_average;
                loopState.bestAttempt = { ...attempt };
            }
        } catch (e) {
            attempt.status = 'error';
            attempt.error = e.message;
            loopState.attempts.push(attempt);
            console.log(`EVALUATION FAILED: ${e.message}`);
            loopState.status = 'failed_evaluation';
            break;
        }

        // ───── EXTRACT FEEDBACK AND CALCULATE NEXT STEP ─────
        loopState.status = 'reviewing';

        // Parse critic's actionable feedback
        const actionItems = loopState.currentEvaluation.action_items || [];

        // Calculate next_step based on score thresholds
        const geometry = loopState.currentEvaluation.geometry_accuracy || 0;
        const interactivity = loopState.currentEvaluation.interactivity_usability || 0;
        const faithfulness = loopState.currentEvaluation.faithfulness || 0;
        const labels = loopState.currentEvaluation.label_quality || 0;
        const concept = loopState.currentEvaluation.concept_accuracy || 0;
        const overall = loopState.currentEvaluation.overall_average || 0;

        // Critical metrics that must all pass
        const CRITICAL_THRESHOLD = 4.0;
        const PASS_OVERALL = 4.0;

        let nextStep = 'pass';

        // Determine if this is a plan issue or generation issue
        if (concept < CRITICAL_THRESHOLD) {
            // Plan issue: concept not well understood
            nextStep = 'fix_plan';
        } else if (interactivity < CRITICAL_THRESHOLD || labels < CRITICAL_THRESHOLD) {
            // Generation issue: implementation/execution problems
            nextStep = 'refine_generation';
        } else if (overall < PASS_OVERALL) {
            // General quality issue; try generation refinement first
            nextStep = 'refine_generation';
        }

        loopState.currentFeedback = {
            next_step: nextStep,
            action_items: actionItems,
            scores: { geometry, interactivity, faithfulness, labels, concept, overall },
        };
        attempt.feedback = loopState.currentFeedback;

        console.log(`Feedback: ${loopState.currentFeedback.next_step}`, {
            overall: overall,
            actions: actionItems.length,
        });

        // ───── CHECK: PASS? ─────
        if (loopState.currentFeedback.next_step === 'pass' && loopState.currentEvaluation.overall_average >= passThreshold) {
            attempt.status = 'passed';
            loopState.attempts.push(attempt);
            loopState.status = 'passed';
            console.log(`\n✓ PASSED on attempt ${attemptNum}/${maxAttempts}`);
            console.log(`Final score: ${loopState.currentEvaluation.overall_average}/5`);
            return loopState;
        }

        // ───── CHECK: MAX ATTEMPTS? ─────
        if (attemptNum >= maxAttempts) {
            attempt.status = 'max_attempts_reached';
            loopState.attempts.push(attempt);
            loopState.status = 'failed_max_attempts';
            console.log(`\n✗ Max attempts (${maxAttempts}) reached`);
            console.log(`Best score achieved: ${loopState.bestScore}/5 on attempt ${loopState.bestAttempt?.iteration || '?'}`);
            return loopState;
        }

        // ───── CHECK: RECOVERABLE? ─────
        // Consider unrecoverable if score is very low and too many failures
        const score = loopState.currentEvaluation.overall_average || 0;
        const failureCount = (loopState.currentEvaluation.failure_modes || []).length;
        const isRecoverable = score >= 2.0 || failureCount <= 3;

        if (!isRecoverable) {
            attempt.status = 'unrecoverable';
            loopState.attempts.push(attempt);
            loopState.status = 'failed_unrecoverable';
            console.log(`\n✗ UNRECOVERABLE: Score ${score}/5 with ${failureCount} failures`);
            console.log(`Best score achieved: ${loopState.bestScore}/5`);
            return loopState;
        }

        // ───── DECIDE & REFINE ─────
        console.log(`\nDeciding on refinement strategy: ${loopState.currentFeedback.next_step}`);

        if (loopState.currentFeedback.next_step === 'fix_plan') {
            console.log(`Refining plan...`);
            attempt.refinement_type = 'plan';

            try {
                loopState.currentPlan = await refinePlan(
                    loopState.currentPlan,
                    loopState.currentEvaluation,
                    loopState.currentFeedback,
                    figureStem,
                    plannerModel
                );
                console.log(`Plan refined`);
            } catch (e) {
                attempt.status = 'plan_refinement_error';
                attempt.error = e.message;
                loopState.attempts.push(attempt);
                console.log(`PLAN REFINEMENT FAILED: ${e.message}`);
                loopState.status = 'failed_plan_refinement';
                break;
            }
        } else if (loopState.currentFeedback.next_step === 'refine_generation') {
            console.log(`Will refine generation on next iteration (using critic feedback)`);
            attempt.refinement_type = 'generation';
        }

        attempt.status = 'refined';
        loopState.attempts.push(attempt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXIT: Return best attempt as fallback
    // ─────────────────────────────────────────────────────────────────────────
    if (loopState.bestAttempt && loopState.status !== 'passed') {
        console.log(`\nReturning best attempt (${loopState.bestScore}/5)`);
        loopState.currentHtml = loopState.bestAttempt.html;
        loopState.currentEvaluation = loopState.bestAttempt.evaluation;
        loopState.currentFeedback = loopState.bestAttempt.feedback;
    }

    return loopState;
}

/**
 * Format loop results for display.
 * Useful for logging or returning to user.
 */
function formatLoopResults(loopState) {
    const lines = [
        `Figure: ${loopState.figureStem}`,
        `Status: ${loopState.status}`,
        `Attempts: ${loopState.attempts.length}`,
        `Best Score: ${loopState.bestScore}/5`,
        '',
        `Attempt History:`,
    ];

    for (const attempt of loopState.attempts) {
        const iterStr = `  [${attempt.iteration}] ${attempt.step}`;
        if (attempt.evaluation) {
            lines.push(`${iterStr}: ${attempt.evaluation.overall_average}/5`);
        } else if (attempt.status === 'error') {
            lines.push(`${iterStr}: ERROR - ${attempt.error}`);
        } else {
            lines.push(`${iterStr}: ${attempt.status}`);
        }
    }

    if (loopState.currentFeedback) {
        lines.push('', 'Final Feedback:');
        lines.push(...loopState.currentFeedback.actionItems.map(a => `  ${a}`));
    }

    return lines.join('\n');
}

module.exports = {
    runFigureLoop,
    formatLoopResults,
};
