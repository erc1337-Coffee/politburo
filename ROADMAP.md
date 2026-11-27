# Roadmap

Work that is not built. Each item needs a design before any code.

## Chat and code platform bridges

Bring the conversations of other platforms into board threads, so that the board holds the whole history of a piece of work.

- Chat bridges, for example Discord, Slack and Telegram: messages, replies and files between a channel there and a board channel.
- GitHub: the review comments, reviews, checks and state of the draft PRs that the orchestrator opens, shown in the thread of the task that made the PR.

The board accepts no connection from the internet. A bridge must therefore poll the platform or receive its events through the relay.
