// The next step after a worker `result`. The orchestrator applies hard limits around any policy.
import type { ResultData } from '@remilia/politburo-relay/messages'

export type NextStep =
  | { kind: 'publish' }
  /** The task is done and needed no change: it closes with the worker's answer. */
  | { kind: 'complete' }
  | { kind: 'instruct'; text: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'hold'; question: string }

export interface DecisionInput {
  task: { id: string; brief: string; channel: string }
  attempt: { no: number; round: number; costUsd: number; wallMs: number }
  result: ResultData
  /** The bundle arrived whole and its sha256 matches the result. */
  bundleReceived: boolean
}

export interface DecisionLimits { roundsPerAttempt: number; attemptsPerTask: number; attemptWallMs: number; taskBudgetUsd: number; taskCostUsd: number }

export interface NextStepPolicy { decide(input: DecisionInput): Promise<NextStep> }

const tail = (text: string, max: number) => (text.length > max ? text.slice(-max) : text)

/**
 * Fixed rules: a completed round with all checks passing is published, or closes the task when
 * it changed nothing (a failed model call ends the round as failed, not completed); failing checks get one
 * more round with their output; a worker that ended without a result is retried in a new session.
 */
export const fixedRulesPolicy: NextStepPolicy = {
  async decide({ result }) {
    const failing = result.checks.filter((check) => check.exit_code !== 0)
    if (result.exit_reason === 'completed' && failing.length === 0) {
      if (result.diff_stat.files === 0) return { kind: 'complete' }
      return { kind: 'publish' }
    }
    if (result.exit_reason === 'completed' || result.exit_reason === 'failed') {
      if (failing.length > 0) {
        const report = failing.map((check) => `Check ${check.name} exited ${check.exit_code}:\n${tail(check.output_tail, 1_500)}`).join('\n\n')
        return { kind: 'instruct', text: `These checks fail on your branch. Fix the cause, keep the scope of the task, run the checks again.\n\n${report}` }
      }
      return { kind: 'retry', reason: `the worker round ended with ${result.exit_reason}` }
    }
    if (result.exit_reason === 'stopped') return { kind: 'fail', reason: 'the attempt was stopped' }
    return { kind: 'retry', reason: `the worker ended with ${result.exit_reason}` }
  },
}

/** Applies the hard limits and the publication precondition to a policy's answer. */
export function limitStep(step: NextStep, input: DecisionInput, limits: DecisionLimits): NextStep {
  if (step.kind === 'publish') {
    if (!input.result.head_commit || !input.bundleReceived) return { kind: 'retry', reason: 'the worker sent no complete bundle of its commits' }
    return step
  }
  const overBudget = limits.taskCostUsd > limits.taskBudgetUsd
  const overWall = input.attempt.wallMs > limits.attemptWallMs
  if (step.kind === 'instruct' && (input.attempt.round >= limits.roundsPerAttempt || overBudget || overWall)) {
    return input.attempt.no < limits.attemptsPerTask && !overBudget
      ? { kind: 'retry', reason: 'round limit reached' }
      : { kind: 'fail', reason: overBudget ? 'task budget used up' : 'round and attempt limits reached' }
  }
  if (step.kind === 'retry' && (input.attempt.no >= limits.attemptsPerTask || overBudget)) {
    return { kind: 'fail', reason: `${step.reason}; ${overBudget ? 'task budget used up' : 'attempt limit reached'}` }
  }
  return step
}
