import type { CliArgument, CliCommand, groups, option } from './commands.ts'

type GroupedCommand = CliCommand & { readonly group: (typeof groups)[number] }
type Option = typeof option
type TaskArgument = (description?: string) => CliArgument

export const controlOptions = {
  reason: { type: 'string', value: 'reason', description: 'why, recorded in the board log (required)' },
} as const

export const teamOptions = {
  host: { type: 'string', value: 'bind-ip', description: 'the IP to listen on (default: 127.0.0.1); requires --team-tokens' },
  'team-tokens': { type: 'string', value: 'file', description: 'serve only the API, using team tokens from a JSON file' },
} as const

export const serveOptions = {
  responder: { type: 'string', multiple: true, value: 'principal', description: 'also let this principal answer task attention where they can read and post' },
  'model-routes': { type: 'string', value: 'file', description: 'model routes for channels (swarm sprite routes output)' },
  'operations-url': { type: 'string', value: 'url', description: "the orchestrator's status server for the operations view, on this machine (e.g. http://127.0.0.1:4780)" },
  'ledger-file': { type: 'string', value: 'file', description: 'the spend ledger the operations view reads usage from' },
} as const

export const priorityOptions = {
  priority: { type: 'string', value: 'level', description: 'lowest, low, normal (default), high, or urgent' },
} as const

export const authorityOptions = {
  binding: { type: 'string', value: 'JSON', description: 'claim metadata: controller, owner, provider, model, session, branch, worktree, and baseCommit' },
  supersedes: { type: 'string', value: 'id', description: 'the current handoff ID when replacing one' },
} as const

export const attentionOptions = {
  commit: { type: 'string', value: 'sha', description: 'the full lowercase SHA on the request' },
} as const

export const admissionCommands = (option: Option): readonly GroupedCommand[] => [
  {
    group: 'the board',
    name: 'status',
    description: 'see if the board is admitting work',
    arguments: [],
    options: [],
    examples: [{ name: 'check the board', value: 'status' }],
  },
  {
    group: 'the board',
    name: 'pause',
    description: 'stop task claims and scheduled sends on the board',
    brief: '--reason <reason>',
    arguments: [],
    options: [option('reason')],
    examples: [{ name: 'pause work during maintenance', value: 'pause --reason "queue maintenance"' }],
  },
  {
    group: 'the board',
    name: 'resume',
    description: 'allow new task claims and future scheduled sends',
    brief: '--reason <reason>',
    arguments: [],
    options: [option('reason')],
    examples: [{ name: 'resume work after maintenance', value: 'resume --reason "maintenance complete"' }],
  },
]

export const taskPriorityCommands = (task: TaskArgument, priorityDescription: string): readonly CliCommand[] => [
  {
    name: 'show',
    description: 'show one task, including its priority',
    arguments: [task()],
    options: [],
    examples: [{ name: 'show a task', value: 'tasks show 812' }],
  },
  {
    name: 'priority',
    description: 'set a task’s priority; with your claim, only lower it',
    arguments: [task(), { name: 'level', required: true, description: priorityDescription }],
    options: [],
    examples: [{ name: 'set a task’s priority', value: 'tasks priority 812 high' }],
  },
]

export const taskAttentionCommands = (task: TaskArgument, option: Option): readonly CliCommand[] => [
  {
    name: 'ask',
    description: 'hold a task for a decision on a specific commit',
    arguments: [task()],
    options: [option('file', 'a JSON draft with kind, question, context, options, evidence, expiresAt, commit, revision, and optional replaces: - reads stdin')],
    examples: [{ name: 'ask for a decision', value: 'tasks ask 813 --file attention.json' }],
  },
  {
    name: 'attention',
    description: 'read the current attention request on a task',
    arguments: [task()],
    options: [],
    examples: [{ name: 'read the request and its options', value: 'tasks attention 813' }],
  },
  {
    name: 'answer',
    description: 'choose an option on a task attention request, as a configured responder',
    arguments: [task(), { name: 'request-id', required: true, description: 'the current attention request ID' }, { name: 'option', required: true, description: 'the option ID to choose, such as approve or retry-2' }],
    options: [option('commit')],
    examples: [{ name: 'answer an attention request', value: 'tasks answer 813 7c9a5f1e-2d84-4b6a-9e3c-5f8a1d2b6740 approve --commit 8f3a2c7e9b1d4f6a0c5e8b2d7f1a3c9e4b6d0f2a' }],
  },
]

export const taskAuthorityCommands = (task: TaskArgument, option: Option): readonly CliCommand[] => [
  {
    name: 'park',
    description: 'put a task on operator hold and end any claim: as yourself with manage in its channel',
    arguments: [task(), { name: 'reason', required: true, description: 'why, in a line' }],
    options: [],
    examples: [{ name: 'park a task', value: 'tasks park 813 "waiting for the maintenance window"' }],
  },
  {
    name: 'unpark',
    description: 'lift an operator hold without restoring the claim: as yourself with manage in its channel',
    arguments: [task(), { name: 'reason', required: true, description: 'why, in a line' }],
    options: [],
    examples: [{ name: 'unpark a task', value: 'tasks unpark 813 "maintenance window opened"' }],
  },
  {
    name: 'handoff',
    description: 'record a handoff with your claim, without reading the packet or ending the lease',
    arguments: [
      task(),
      { name: 'commit', required: true, description: 'a full lowercase commit ID' },
      { name: 'packet-path', required: true, description: 'the path to the packet relative to the repository root' },
      { name: 'sha256', required: true, description: 'the lowercase SHA-256 digest of the packet' },
    ],
    options: [option('supersedes')],
    examples: [],
  },
]
