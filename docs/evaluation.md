# Evaluation

Pi Agent IDE is still experimental. Evaluation compares it with vanilla Pi instead of assuming that richer tools always improve agent behavior.

Current studies use repeatable coding tasks and editing gyms. They inspect:

- task completion and correctness;
- tool calls and failed tool calls;
- input, output, and cache tokens;
- unnecessary reads and repeated searches;
- edit retries and recovery from stale context;
- cases where specialized tools make a task harder.

Results depend on the model, prompt, repository, and task. A result from one suite is evidence about that suite, not a universal performance claim.
