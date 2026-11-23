# Develop nightly

The public repository runs the normal CI suite on a pinned `develop` commit around midnight in Berlin. GitHub Actions cron uses UTC, so `.github/workflows/nightly.yml` runs at both 22:00 and 23:00 UTC. Only the run that falls in Berlin's midnight hour continues. GitHub may delay scheduled runs; if it starts after that hour, it is skipped. Use **Run workflow** to retry a missed night.

GitHub starts scheduled runs from the workflow file on the default branch. `develop` is the default branch, so a change to this workflow takes effect on the next night after it merges to `develop`; it does not wait for a release.

Successful runs retain an installable `nightly-package` archive for 30 days. Unit and integration test reports are retained as `test-results` for 30 days, including failed runs when reports are available. Download the archive from the workflow run and install that exact `.tgz` in a disposable Pi environment to try the build. Nightlies are not published to npm and do not change `latest`.

The nightly runner pins the `develop` commit before calling the same CI workflow used for regular changes. Its package is scanned and smoke-installed. A failed run is the regression report; inspect its job logs and test artifacts.

A failed nightly opens a `Develop nightly is failing` issue labeled `nightly`, with the run link and the failed jobs. While that issue is open, each failed night adds a comment; the next passing nightly closes it. The workflow's `report` job does this with the run's own token. The owner also gets an email for every failed run and for a night with no nightly build at all; the GitHub intake receiver in agent-infrastructure sends both.

To test this path, run the workflow manually with **simulate_failure** checked. The run fails before building anything and opens a separate `Develop nightly is failing (simulated test)` issue; close it by hand afterwards.
