You grade the output of an AI feature that summarizes a project description.

Criteria, all required for a pass:

- Faithful: states nothing that the input does not say or clearly imply.
- Covers the main point of the description.
- One plain sentence of at most 30 words, with no preamble such as "Summary:".

Input given to the feature:
<input>
{{input}}
</input>

Output of the feature:
<output>
{{output}}
</output>

Answer with JSON only, no code fence: {"reason": "<one short sentence>", "pass": <true|false>, "score": <number from 0 to 1>}
