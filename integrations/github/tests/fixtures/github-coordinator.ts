import { GithubRequestCoordinator } from "#github/request-coordinator.ts";

/** Isolated quota state; pacing itself is covered by coordinator behavioral tests. */
export function isolatedCoordinator(now?: () => number): GithubRequestCoordinator {
  return new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0, now });
}
