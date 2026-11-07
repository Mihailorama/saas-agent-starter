// Key-free provider: returns the output recorded in the golden dataset (`recorded_output`)
// instead of calling a model. Checks the dataset and the rule assertions, not the prompt.
export default class Replay {
  id() {
    return 'replay';
  }
  async callApi(_prompt, context) {
    return { output: context.vars.recorded_output };
  }
}
