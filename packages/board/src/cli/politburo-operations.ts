import { cli, client, flags, out, result, usage } from './main.ts'

export function portFlag(): number | undefined {
  const port = flags.port === undefined ? undefined : Number(flags.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
    throw usage(flags['team-tokens'] === undefined ? `${flags.port} isn't a port.` : '--port needs an integer from 0 to 65535.', { reason: 'invalid_port' })
  return port
}

export async function boardStatus(command: 'status' | 'pause' | 'resume', args: string[]): Promise<number> {
  if (args.length > 0) throw usage(`${command} takes no positional arguments.`)
  const reason = flags.reason
  if (command !== 'status' && !reason?.trim()) {
    throw usage(`Missing why to ${command} the board: pass --reason <reason>.`, {
      reason: 'missing_arguments',
      next: [{ instruction: 'Give a reason', argv: [...cli(), command, '--reason', '<REASON>'] }],
    })
  }
  const board = client()
  const status = command === 'status' ? await board.status() : await board[command](reason!)
  if (flags.json) result(status)
  else out(`board  ${status.paused ? 'paused' : 'running'}`)
  return 0
}
