"""Provision pinned Julia debugging tools in one private, disposable fixture directory.

Run explicitly before the Julia SSH tests. The JSON receipt contains the environment
paths to pass to those tests. Remove only the reported root after all users stop.
No user depot, startup file or global installation is used.
"""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import pwd
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


VERSION = "1.13.0"
URL = "https://julialang-s3.julialang.org/bin/linux/x64/1.13/julia-1.13.0-linux-x86_64.tar.gz"
SHA256 = "8975da61c128a5e5ded3e719e868da8c8781deb7ad7913d37fb99be02a81904b"
SIZE = 302893995


def provision():
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("This fixture requires Linux x86_64")
    account = pwd.getpwnam("agent") if os.getuid() == 0 else pwd.getpwuid(os.getuid())
    if account.pw_uid == 0:
        raise RuntimeError("The Julia fixture must run as an unprivileged account")
    parent = pathlib.Path(tempfile.gettempdir()) / ".tmp"
    parent.mkdir(mode=0o755, exist_ok=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-ide-julia-", dir=parent))
    root.chmod(0o755)
    try:
        archive = root / "julia.tar.gz"
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                output.write(chunk)
        if digest.hexdigest() != SHA256 or size != SIZE:
            raise RuntimeError("Official pinned Julia archive checksum or size differs")
        with tarfile.open(archive, "r:gz") as package:
            package.extractall(root, filter="data")
        archive.unlink()
        runtime = root / f"julia-{VERSION}" / "bin" / "julia"
        project = root / "project"
        depot = root / "depot"
        home = root / "home"
        for directory in (project, depot, home):
            directory.mkdir(mode=0o755)
            os.chown(directory, account.pw_uid, account.pw_gid)
        environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(home),
            "JULIA_DEPOT_PATH": str(depot),
            "JULIA_LOAD_PATH": "@:@stdlib",
            "JULIA_NUM_THREADS": "1",
            "JULIA_NUM_PRECOMPILE_TASKS": "1",
        }
        command = [
            str(runtime), "--startup-file=no", "--history-file=no", f"--project={project}",
            "-e", 'using Pkg; Pkg.add(PackageSpec(name="DebugAdapter", version="3.2.1")); '
            'Pkg.precompile(); using DebugAdapter; '
            'println("Private Julia ", VERSION, " / DebugAdapter ", pkgversion(DebugAdapter))',
        ]
        subprocess.run(
            command, env=environment, cwd=root, check=True, timeout=900,
            **({"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []}
               if os.getuid() == 0 else {}),
        )
        print(json.dumps({
            "root": str(root), "runtime": str(runtime), "project": str(project),
            "depot": str(depot), "home": str(home), "archiveSha256": SHA256,
            "juliaVersion": VERSION, "debugAdapterVersion": "3.2.1",
        }), flush=True)
    except BaseException:
        shutil.rmtree(root)
        raise


def remove_installation(value):
    root = pathlib.Path(value)
    parent = pathlib.Path(tempfile.gettempdir()) / ".tmp"
    if (root.parent != parent or not root.name.startswith("pi-ide-julia-")
            or root.is_symlink() or root.resolve() != root):
        raise ValueError("Cleanup accepts only an exact private fixture receipt root")
    runtime = root / f"julia-{VERSION}" / "bin" / "julia"
    if not runtime.is_file() or not (root / "project" / "Manifest.toml").is_file():
        raise ValueError("The selected root is not the provisioned Julia fixture")
    shutil.rmtree(root)
    print(json.dumps({"removedRoot": str(root), "absent": not root.exists()}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remove", metavar="RECEIPT_ROOT",
                        help="Remove the exact own receipt root, only after all fixture users stop")
    arguments = parser.parse_args()
    if arguments.remove:
        remove_installation(arguments.remove)
    else:
        provision()
