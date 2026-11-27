// `@vercel/board` in Node: board() reaches the board at `BOARD_URL` when no backend is passed, and can
// serve a board it keeps, verifying the OIDC tokens made out to it.
import { http } from '../backend-http/index.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. Without a `backend`, it's the board at `BOARD_URL` (`vb serve`'s, say),
 * reached with the credentials `vb` finds; without `BOARD_URL` either, it fails with `no_board`.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, {
    backend: () => http(),
    serving: () => import('./serving.ts'),
  })
}

export * from './exports.ts'
