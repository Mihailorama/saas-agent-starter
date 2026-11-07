// Plumbing check for the LLM-judge path without a key (`pnpm eval --fake-llm`, part of
// `pnpm check`): passes when the rendered judge prompt contains the input and the output.
export default class FakeJudge {
  id() {
    return 'fake-judge';
  }
  async callApi(prompt) {
    const ok = /<input>\s*\S[\s\S]*<\/input>/.test(prompt) && /<output>\s*\S/.test(prompt);
    return {
      output: JSON.stringify({ reason: 'fake judge', pass: ok, score: ok ? 1 : 0 }),
    };
  }
}
