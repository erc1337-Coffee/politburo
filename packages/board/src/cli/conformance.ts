import { conformance } from '../conformance/index.ts'
import { formatConformance } from './format.ts'
import { client, connection, flags, io, out, result } from './main.ts'

export async function checkConformance(): Promise<number> {
  // The same board with this run's own credential and headers of the run's (x-board-can, a profile), as a proxy holding it sends them:
  // what `vb()` was handed can't be opened again.
  const connected = io.board ? null : connection()
  const board = connected?.board ?? client()
  // Open the board first: one it can't reach (no room for it, no grant, a lapsed login) is this run's error, not a check the board failed.
  await board.me()
  const report = await conformance(board, {
    ...(flags.channel ? { channel: flags.channel } : {}),
    ...(connected ? { withHeaders: (headers: Record<string, string>) => connection(undefined, { headers }).board } : {}),
  })
  if (flags.json) result(report)
  else out(formatConformance(report))
  return report.ok ? 0 : 1
}
