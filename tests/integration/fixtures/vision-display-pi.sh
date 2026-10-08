#!/bin/sh
# Enable display capture explicitly only in the isolated graphical integration run.
exec "${PI_COMMAND:-pi}" --pi-agent-ide-vision-displays "$@"
