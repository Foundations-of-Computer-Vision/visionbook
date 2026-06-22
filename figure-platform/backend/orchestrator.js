const { generateWithModel } = require('./models');

const ORCHESTRATOR_DEFAULT_MODEL = 'gpt-4o';
const ORCHESTRATOR_MAX_TOKENS = 1024;

function buildOrchestratorPrompt(useFewShot = true) {
    return `You are the orchestration agent for an iterative figure-generation loop. Generation works by taking an original 2D figure, generating an interactive 3D figure from it, and evaluating the result.

You will receive the critic evaluation, including failure modes, scores, notes, and action items.
Your job is to decide the next action:
- pass: the figure is good enough to stop iterating
- refine_generation: the implementation has concrete issues (labels, geometry, color, interactivity, camera) that the generator can fix given the critic feedback

Use the failure modes and action items as the primary evidence. Do not decide from raw score thresholds alone.

Return ONLY valid JSON with this exact shape:
{
	"next_step": "pass | refine_generation",
	"rationale": "one concise sentence explaining the decision"
}

${useFewShot ? `CALIBRATION EXAMPLES — use these to calibrate your judgment:

Example 1 — correct decision: pass
Evaluation:
${JSON.stringify({ discrepancies: ["The arrow labels (x1, y1) colors don't match the original green.", "Curved arrow in the bottom is more pronounced in the HTML version.", "Camera representations differ: solid shapes vs outlined in source.", "Label 'p2?' is missing the '?' in the HTML version."], failure_modes: ["Color-Wrong", "Missing-Labels"], geometry_accuracy: 4, interactivity_usability: 4, faithfulness: 3, label_quality: 3, concept_accuracy: 4, notes: "Interactive elements are mostly functional, but visual and label details do not fully align with the source.", action_items: ["Adjust the colors of arrow labels to match the original figure.", "Ensure all labels match exactly, including punctuation marks like '?'."], overall_average: 3.6 }, null, 2)}
Decision: {"next_step": "pass", "rationale": "Scores are consistently high (mostly 4s), failure modes are minor visual polish issues, and concept and interactivity are solid — further iteration is unlikely to yield meaningful improvement."}

Example 2 — correct decision: refine_generation
Evaluation:
${JSON.stringify({ discrepancies: ["Text overlaps in 3D rendering causing poor readability", "Projection plane opacity misaligned with original", "Axis colors do not match original", "Incorrect perspective lengths for arrows and lines", "3D object has different shade/color than 2D"], failure_modes: ["Color-Wrong", "Scale-Wrong", "Interaction-Missing", "Camera-Wrong"], geometry_accuracy: 3, interactivity_usability: 3, faithfulness: 3, label_quality: 3, concept_accuracy: 3, notes: "The rendering contains overlapping text, varying colors, and lacks precise interactivity, making it somewhat difficult to grasp the 3D representation.", action_items: ["Fix text overlap by adjusting label positions and scaling.", "Align colors and transparency with source to enhance visual consistency.", "Improve 3D element proportions and viewpoint to better simulate depth."], overall_average: 3.0 }, null, 2)}
Decision: {"next_step": "refine_generation", "rationale": "The concept is present but execution has multiple implementation-level issues — color mismatches, missing interactions, wrong camera angle, scale errors — all fixable by the generator."}` : ''}`;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(Boolean);
}

function finalizeDecision(decision, evaluation) {
    const nextStep = ['pass', 'refine_generation'].includes(decision?.next_step)
        ? decision.next_step
        : 'refine_generation';

    return {
        next_step: nextStep,
        rationale: String(decision?.rationale || '').trim() || 'Decision derived from critic feedback.',
    };
}

/**
 * Decide whether the next iteration should refine the plan, refine the generation,
 * or stop.
 *
 * @param {{
 *   evaluation: object,
 *   model?: string,
 *   maxTokens?: number,
 * }} opts
 * @returns {Promise<object>}
 */
async function decideFigureRefinement(opts) {
    const {
        evaluation,
        model = ORCHESTRATOR_DEFAULT_MODEL,
        maxTokens = ORCHESTRATOR_MAX_TOKENS,
        useFewShot = true,
    } = opts || {};

    if (!evaluation) throw new Error('evaluation is required');

    const userContent = [{
        type: 'text',
        text: `Critic evaluation JSON:\n${JSON.stringify(evaluation, null, 2)}\n\nDecide whether the next iteration should pass or refine the generation. Output only the JSON object described in the system prompt.`,
    }];

    let content = await generateWithModel(model || ORCHESTRATOR_DEFAULT_MODEL, {
        systemPrompt: buildOrchestratorPrompt(useFewShot),
        userContent,
        maxTokens,
    });

    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) content = fenced[1].trim();
    content = content.trim();

    let decision;
    try {
        decision = JSON.parse(content);
    } catch {
        return finalizeDecision({
            next_step: 'refine_generation',
            rationale: `Fallback decision used because the orchestrator output was not valid JSON: ${content.slice(0, 200)}`,
        }, evaluation);
    }

    return finalizeDecision(decision, evaluation);
}

module.exports = {
    ORCHESTRATOR_DEFAULT_MODEL,
    decideFigureRefinement,
};
