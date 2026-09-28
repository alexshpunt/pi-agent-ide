# Develop nightly

The public repository runs the normal CI suite on a pinned `develop` commit around midnight in Berlin. GitHub Actions cron uses UTC, so `.github/workflows/nightly.yml` runs at both 22:00 and 23:00 UTC. Only the run that falls in Berlin's midnight hour continues. GitHub may delay scheduled runs; if it starts after that hour, it is skipped. Use **Run workflow** to retry a missed night.

Successful runs retain an installable `nightly-package` archive for 30 days. Unit and integration test reports are retained as `test-results` for 30 days, including failed runs when reports are available. Download the archive from the workflow run and install that exact `.tgz` in a disposable Pi environment to try the build. Nightlies are not published to npm and do not change `latest`.

The nightly runner pins the `develop` commit before calling the same CI workflow used for regular changes. Its package is scanned and smoke-installed. A failed run is the regression report; inspect its job logs and test artifacts. This workflow is active only after a public `develop` branch and this workflow have been merged into the public repository.
