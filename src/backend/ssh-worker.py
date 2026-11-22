"""One framed operation over SSH stdin/stdout. No persistent helper installation.

The host bundles this entry with `ssh_worker_common` and the target's platform module,
published as `ssh_worker_platform`.
"""
import ssh_worker_common
import ssh_worker_platform

ssh_worker_common.run(ssh_worker_platform)
