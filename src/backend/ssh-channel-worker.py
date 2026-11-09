"""Transient framed pipe/PTY channel for remote services. Nothing is installed remotely.

The host bundles this entry with `ssh_channel_common` and the target's platform module,
published as `ssh_channel_platform`.
"""
import ssh_channel_platform

ssh_channel_platform.main()
