---
'@vercel/board': patch
---

Lock each local board directory to one process. If another process owns it, the error says to use `--url` to reach the running board.
