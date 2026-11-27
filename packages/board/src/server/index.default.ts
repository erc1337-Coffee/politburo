// `@vercel/board` outside Node (a browser, say): board() with nothing that needs Node. It finds no
// board or credentials in the environment, and verifies no tokens by itself, so pass a backend (and
// to serve requests, `authenticate`); everything else runs as it does in Node.
import { createBoard, type Board, type BoardOptions } from './board.ts'

/** The handle on a board: pass the backend, `board({ backend: http(url) })`, whose `fetch` sends the page's own session. */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, {
    backend: () => {
      throw new Error("board: pass a backend, board({ backend: http(url) }): outside Node there's no BOARD_URL to find a board at")
    },
    serving: null,
  })
}

export * from './exports.ts'
