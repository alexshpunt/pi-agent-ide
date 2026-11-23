const sharedRunnerEnvironment = "PI_INTEGRATION_TEST_RUNNER";

/**
 * Forces one integration test file to use fresh Pi processes.
 * Use this for process-local isolation, exit codes, or when Pi must exit before
 * teardown removes a fixture-owned agent directory.
 */
export function forceStandaloneIntegrationFile(): () => void {
  const endpoint = process.env[sharedRunnerEnvironment];
  delete process.env[sharedRunnerEnvironment];
  return () => {
    if (endpoint === undefined) delete process.env[sharedRunnerEnvironment];
    else process.env[sharedRunnerEnvironment] = endpoint;
  };
}
