const sharedRunnerEnvironment = "PI_INTEGRATION_TEST_RUNNER";

/**
 * Forces one integration test file to use fresh Pi processes.
 * Use this only when the file verifies process-local isolation or exit codes.
 */
export function forceStandaloneIntegrationFile(): () => void {
  const endpoint = process.env[sharedRunnerEnvironment];
  delete process.env[sharedRunnerEnvironment];
  return () => {
    if (endpoint === undefined) delete process.env[sharedRunnerEnvironment];
    else process.env[sharedRunnerEnvironment] = endpoint;
  };
}
