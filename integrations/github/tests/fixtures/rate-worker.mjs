import { GithubRequestCoordinator } from "#github/request-coordinator.ts";
const [directory,url,owner]=process.argv.slice(2);
try {
  await new GithubRequestCoordinator({directory}).fetch(owner,url,{}, {fetcher:fetch});
  process.stdout.write(JSON.stringify({unexpected:true}));
} catch (error) {
  process.stdout.write(JSON.stringify({code:error.code,effect:error.effect,rateLimit:error.rateLimit}));
}
