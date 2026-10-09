"""Run target PowerShell stdio with a private, short-lived services directory."""
import os
import signal
import subprocess
import sys
import tempfile


def quoted(value):
    return "'" + value.replace("'", "''") + "'"


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupted)

bundle = os.environ.get("PI_POWERSHELL_EDITOR_SERVICES_PATH", "/opt/pi-debug-adapters/powershell-editor-services")
command = os.environ.get("PI_PWSH_PATH", "pwsh")
with tempfile.TemporaryDirectory(prefix="pi-agent-ide-powershell-") as directory:
    script = (
        "& " + quoted(os.path.join(bundle, "PowerShellEditorServices", "Start-EditorServices.ps1"))
        + " -LogPath " + quoted(os.path.join(directory, "logs"))
        + " -LogLevel Warning -SessionDetailsPath " + quoted(os.path.join(directory, "session.json"))
        + " -FeatureFlags @() -AdditionalModules @() -HostName 'Pi Agent IDE'"
        + " -HostProfileId 'pi-agent-ide' -HostVersion '1.0.0' -BundledModulesPath " + quoted(bundle)
        + " -Stdio -DebugServiceOnly"
    )
    child = subprocess.Popen([command, "-NoLogo", "-NoProfile", "-Command", script])
    try:
        code = child.wait()
    finally:
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, signal.SIG_IGN)
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    sys.exit(code if code >= 0 else 128 - code)
