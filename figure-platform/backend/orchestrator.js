const { generateWithModel } = require('./models');

const ORCHESTRATOR_DEFAULT_MODEL = 'claude-opus-4.7';
const ORCHESTRATOR_MAX_TOKENS = 512;

function buildOrchestratorPrompt() {
    return `You are the orchestration agent for an iterative figure-generation loop.

You will receive a critic evaluation for a generated figure, including failure modes, scores, notes, and action items.
Your job is to decide which part of the system is most responsible for the problem:
- planner: the interaction plan or conceptual decomposition is wrong, incomplete, or missing the right elements
- generator: the plan is close to right, but the rendered implementation, labels, layout, interactivity, or execution is broken
- none: the figure is good enough to stop iterating

Use the failure modes and action items as the primary evidence. Do not decide from raw score thresholds alone.
Prefer planner when the critic indicates concept misunderstanding, missing core elements, wrong primitives, or the wrong overall interaction structure.
Prefer generator when the concept is right but the execution needs concrete implementation fixes like labels, wiring, geometry details, styling, or broken controls.

Return ONLY valid JSON with this exact shape:
{
	"next_step": "pass | fix_plan | refine_generation",
	"rationale": "one concise sentence explaining the decision"
}`;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(Boolean);
}

function finalizeDecision(decision, evaluation) {
    const nextStep = ['pass', 'fix_plan', 'refine_generation'].includes(decision?.next_step)
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
    } = opts || {};

    if (!evaluation) throw new Error('evaluation is required');

    const userContent = [{
        type: 'text',
        text: `Critic evaluation JSON:\n${JSON.stringify(evaluation, null, 2)}\n\nDecide whether the next iteration should pass, fix the plan, or refine the generation. Output only the JSON object described in the system prompt.`,
    }];

    let content = await generateWithModel(model || ORCHESTRATOR_DEFAULT_MODEL, {
        systemPrompt: buildOrchestratorPrompt(),
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
