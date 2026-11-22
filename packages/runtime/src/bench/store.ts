import { block, BoardError, type Board } from '@vercel/board'
import { benchRunSchema, isBenchRun, type BenchRun } from './record.ts'

/** Run once with permission to register schemas. */
export async function registerBenchSchema(board: Pick<Board, 'createSchema'>) {
  await board.createSchema({
    name: 'bench-run', version: 1, description: 'Benchmark run counts, identifiers, and times.', schema: benchRunSchema,
  })
}

/**
 * One channel is one read across tasks (paged as needed). Storing blocks on
 * task threads would require enumerating threads and put measurements in the
 * conversation people read.
 */
export function benchStore({ board, channel = 'bench', author }: {
  board: Pick<Board, 'post' | 'posted' | 'channel'>
  channel?: string
  author: string
}) {
  return {
    async record(run: BenchRun) {
      if (!isBenchRun(run)) throw new TypeError('invalid benchmark record')
      const id = `bench-run:${run.runId}`
      const message = await board.post(channel, { id, text: block('bench-run@1', run), noSync: true }).catch(async (error: unknown) => {
        // A changed replay doesn't replace the first write.
        if (!(error instanceof BoardError) || error.code !== 'duplicate_id') throw error
        const existing = await board.posted(id)
        if (existing.channel !== channel || !existing.blocks.some(({ schema, version, data }) =>
          schema === 'bench-run' && version === 1 && isBenchRun(data) && data.runId === run.runId)) throw error
        return existing
      })
      if (message.by.actor !== author) throw new Error('benchmark writer does not match the configured author')
    },
    async read(): Promise<BenchRun[]> {
      const runs = new Map<string, BenchRun>()
      // With no after cursor the handle reads the newest page. Start at zero.
      let after = '0'
      for (;;) {
        const { messages, cursor } = await board.channel(channel).messages({ after, limit: 100 })
        for (const message of messages) {
          if (message.by.actor !== author || message.deleted || message.re !== null) continue
          for (const { schema, version, data } of message.blocks) {
            // Pages are oldest first. The first valid write for each ID wins.
            if (schema === 'bench-run' && version === 1 && isBenchRun(data) && !runs.has(data.runId)) runs.set(data.runId, data)
          }
        }
        if (!messages.length || cursor === after) return [...runs.values()]
        after = cursor
      }
    },
  }
}
