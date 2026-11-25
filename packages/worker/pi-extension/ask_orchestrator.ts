// Pi tool that sends a question to the orchestrator and waits for the answer.
// The worker client watches POLITBURO_QUESTION_DIRECTORY: it sends each question file as a
// `question` message and writes the answer file when the `answer` command arrives.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.POLITBURO_QUESTION_DIRECTORY;
const waitSeconds = Number(process.env.POLITBURO_QUESTION_WAIT_SECONDS ?? "3600");

const askOrchestrator = defineTool({
  name: "ask_orchestrator",
  label: "Ask the orchestrator",
  description:
    "Ask the person who owns this task a question and wait for the answer. Use it only when the task cannot continue without a decision. The answer can take many minutes.",
  parameters: Type.Object({
    question: Type.String({ description: "The question, with the context needed to answer it" }),
    options: Type.Optional(Type.Array(Type.String(), { description: "Possible answers, when there is a short list" })),
  }),
  async execute(_toolCallId, params, signal) {
    if (!directory) throw new Error("ask_orchestrator is not connected to a worker client");
    const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const question = join(directory, `${id}.question.json`);
    const answer = join(directory, `${id}.answer.json`);
    writeFileSync(`${question}.tmp`, JSON.stringify({ id, text: params.question, options: params.options ?? [] }));
    renameSync(`${question}.tmp`, question);
    const deadline = Date.now() + waitSeconds * 1000;
    try {
      while (Date.now() < deadline && !signal?.aborted) {
        if (existsSync(answer)) {
          const text = String((JSON.parse(readFileSync(answer, "utf8")) as { text?: unknown }).text ?? "");
          return { content: [{ type: "text", text: `Answer: ${text}` }], details: undefined };
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return { content: [{ type: "text", text: "No answer arrived. Stop, and report what is done and what is blocked." }], details: undefined };
    } finally {
      rmSync(question, { force: true });
      rmSync(answer, { force: true });
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(askOrchestrator);
}
