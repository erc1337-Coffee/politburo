// Orchestrator: the LAN service that claims board tasks, starts remote workers
// and follows them through the relay. Only the launch journal and the review
// stages exist so far; the service loop is not built.
export { launch, launchKey, openJournal, recover } from './launch.ts'
export type { Attention, Binding, Control, HookStep, Journal, JournalFailure, JournalRecord, LaunchResult, Provider } from './launch.ts'
export * from './stages/index.ts'
