"""Download pinned debugger toolchains into one private, disposable fixture root.

Run explicitly after permission is granted. Pass the JSON receipt paths to SSH
fixtures; do not change global PATH or user configuration. Stop all users before
removing the exact receipt root with --remove.
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
import zipfile


PACKAGES = {
    "elixir": [(
        "otp", "https://builds.hex.pm/builds/otp/amd64/ubuntu-24.04/OTP-27.3.4.2.tar.gz",
        "sha256", "832ce15871f4bb73d921f297e9ef02cbc9d50e04c1df04d69f97c17e2f410649",
    ), (
        "elixir", "https://github.com/elixir-lang/elixir/releases/download/v1.18.4/elixir-otp-27.zip",
        "sha256", "5be18f35e329f7c5914a80dd9f323d7bbb144616df1ed16f6f0862a1900b4bb5",
    ), (
        "elixir-ls", "https://github.com/elixir-lsp/elixir-ls/releases/download/v0.31.1/elixir-ls-v0.31.1.zip",
        "sha256", "bac08322ea3698157eb2373bb5b65e38c15df9dd41e1c06f142f874367fa472f",
    )],
    "jvm": [(
        "jdk", "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.8_9.tar.gz",
        "sha256", "f2dc5418092c43003db8f9005c4a286e1c0104fea96ccdd49e8ebd037cac9219",
    ), (
        "kotlin", "https://github.com/JetBrains/kotlin/releases/download/v2.2.20/kotlin-compiler-2.2.20.zip",
        "sha256", "81f0264c9073b5cbbdb3ff8418cf2c5dac076879fc156fa1a6462f5a5acc4420",
    ), (
        "adapter", "https://github.com/fwcd/kotlin-debug-adapter/releases/download/0.4.4/adapter.zip",
        "sha256", "3874cbaded0fdb8229a381167895b0a6caf88b7adffabc690fcf5a6fb65d11b6",
    )],
    "dart": [(
        "dart", "https://storage.googleapis.com/dart-archive/channels/stable/release/3.13.3/sdk/dartsdk-linux-x64-release.zip",
        "sha256", "549c182cffbdc6864df7509c16fec646c73fe6cb8a18c2cb572db1292f300cd7",
    )],
    "dotnet": [(
        "dotnet", "https://builds.dotnet.microsoft.com/dotnet/Sdk/8.0.425/dotnet-sdk-8.0.425-linux-x64.tar.gz",
        "sha512", "934b8060a7190e5909ad1fd0785db542f487b3bbf6cdd14826b02095fdd0d0394298b1634085eff302928fccc33f7c1a7253e9b87df555fc36fce819bcd2e798",
    ), (
        "netcoredbg", "https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-linux-amd64.tar.gz",
        "sha256", "080eb3b2d2152465f599d3b33d1ee6e747794e11cc0a3773ec689f5e5f2c5afa",
    )],
    "zig": [(
        "zig", "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz",
        "sha256", "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
    )],
    "swift": [(
        "swift", "https://download.swift.org/swift-6.3.3-release/ubuntu2404/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE-ubuntu24.04.tar.gz",
        "signature", None,
    )],
}


# Compare the adapter on Java 17 without replacing the retained Java 21
# failure receipt. The official adapter binary requires at least Java 11.
PACKAGES["jvm17"] = [(
    "jdk", "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.16%2B8/OpenJDK17U-jdk_x64_linux_hotspot_17.0.16_8.tar.gz",
    "sha256", "166774efcf0f722f2ee18eba0039de2d685b350ee14d7b69e6f83437dafd2af1",
), *PACKAGES["jvm"][1:]]

def download(url, destination):
    request = urllib.request.Request(url, headers={"User-Agent": "pi-ide-private-fixture"})
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > 2 * 1024 * 1024 * 1024:
                raise RuntimeError("Fixture archive exceeds its download budget")
            digest.update(chunk)
            output.write(chunk)
    return {"url": url, "sha256": digest.hexdigest(), "bytes": size}


def extract(archive, destination, zipped):
    destination.mkdir(mode=0o755)
    if zipped:
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                resolved = (destination / member.filename).resolve()
                if not resolved.is_relative_to(destination):
                    raise ValueError("Archive path escapes its private root")
                mode = member.external_attr >> 16
                if mode & 0o170000 == 0o120000:
                    raise ValueError("Zip symlinks are not accepted")
                package.extract(member, destination)
                if mode & 0o111:
                    resolved.chmod(0o755)
    else:
        with tarfile.open(archive) as package:
            package.extractall(destination, filter="data")


def provision(group):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("These fixtures require Linux x86_64")
    account = pwd.getpwnam("agent") if os.getuid() == 0 else pwd.getpwuid(os.getuid())
    if account.pw_uid == 0:
        raise RuntimeError("Fixture tools must run as an unprivileged account")
    parent = pathlib.Path(tempfile.gettempdir()) / ".tmp"
    parent.mkdir(mode=0o755, exist_ok=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-ide-debuggers-", dir=parent))
    root.chmod(0o755)
    print(json.dumps({"provisioningRoot": str(root), "group": group}), flush=True)
    try:
        archives = []
        for name, url, algorithm, expected in PACKAGES[group]:
            archive = root / (name + (".zip" if url.endswith(".zip") else ".tar"))
            receipt = download(url, archive)
            if algorithm == "signature":
                signature = root / "swift.sig"
                keys = root / "swift-keys.asc"
                download(url + ".sig", signature)
                download("https://www.swift.org/keys/all-keys.asc", keys)
                keyring = root / "gnupg"
                keyring.mkdir(mode=0o700)
                command = ["gpg", "--batch", "--homedir", str(keyring)]
                subprocess.run(command + ["--import", str(keys)], check=True, timeout=30)
                subprocess.run(command + ["--verify", str(signature), str(archive)], check=True, timeout=30)
                receipt["verification"] = "Official Swift detached signature with private keyring"
                subprocess.run(["gpgconf", "--homedir", str(keyring), "--kill", "gpg-agent"], check=True, timeout=30)
            else:
                digest = hashlib.new(algorithm)
                with archive.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                if digest.hexdigest() != expected:
                    raise RuntimeError(f"Pinned {name} archive checksum differs")
                receipt["verification"] = (
                    "Pinned TLS-acquired SHA256; this older upstream asset has no published digest"
                    if name == "adapter" else "Pinned upstream " + algorithm
                )
            extract(archive, root / name, url.endswith(".zip"))
            archive.unlink()
            archives.append(receipt)
        home = root / "home"
        home.mkdir(mode=0o755)
        os.chown(home, account.pw_uid, account.pw_gid)
        environment = {"HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"),
                       "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data")}
        if group == "elixir":
            installers = list((root / "otp").rglob("Install"))
            if len(installers) != 1:
                raise RuntimeError("Expected one private OTP installer")
            otp = installers[0].parent
            for entry in [root / "otp", *(root / "otp").rglob("*")]:
                os.chown(entry, account.pw_uid, account.pw_gid, follow_symlinks=False)
            options = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []} if os.getuid() == 0 else {}
            subprocess.run([str(installers[0]), "-minimal", str(otp)], cwd=otp,
                           env=environment, check=True, timeout=60, **options)
            runtime = root / "elixir/bin/elixir"
            environment.update({"MIX_HOME": str(home / "mix"), "HEX_HOME": str(home / "hex"),
                                "HEX_CACERTS_PATH": "/etc/ssl/certs/ca-certificates.crt",
                                "ERL_FLAGS": "+S 2:2", "ERLANG_HOME": str(otp)})
        elif group == "dart":
            runtime = root / "dart/dart-sdk/bin/dart"
        elif group == "dotnet":
            runtime = root / "dotnet/dotnet"
            environment.update({"DOTNET_ROOT": str(root / "dotnet"), "DOTNET_CLI_HOME": str(home),
                                "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
                                "NUGET_PACKAGES": str(home / "nuget")})
        elif group == "zig":
            runtime = root / "zig/zig-x86_64-linux-0.15.2/zig"
            environment.update({"ZIG_GLOBAL_CACHE_DIR": str(home / "zig-cache")})
        elif group in ("jvm", "jvm17"):
            runtimes = list((root / "jdk").glob("*/bin/java"))
            if len(runtimes) != 1:
                raise RuntimeError("Expected one private JDK runtime")
            runtime = runtimes[0]
            environment["JAVA_HOME"] = str(runtime.parent.parent)
            environment["JAVA_TOOL_OPTIONS"] = "-Duser.home=" + str(home)
        else:
            runtime = root / "swift/swift-6.3.3-RELEASE-ubuntu24.04/usr/bin/swiftc"
        environment["PATH"] = str(runtime.parent) + (":" + str(otp / "bin") if group == "elixir" else "") + ":/usr/local/bin:/usr/bin:/bin"
        version_argument = "version" if group == "zig" else "-version" if group in ("jvm", "jvm17") else "--version"
        command = [str(runtime), version_argument]
        if group == "dart":
            command = [str(runtime), "--disable-analytics"]
        options = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []} if os.getuid() == 0 else {}
        subprocess.run(command, env=environment, cwd=home, check=True, timeout=60, **options)
        if group == "dart":
            subprocess.run([str(runtime), "--version"], env=environment, cwd=home, check=True, timeout=60, **options)
        receipt = {"root": str(root), "group": group, "runtime": str(runtime),
                   "environment": environment, "archives": archives}
        (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)
    except BaseException:
        shutil.rmtree(root)
        raise


def remove(value):
    root = pathlib.Path(value)
    parent = pathlib.Path(tempfile.gettempdir()) / ".tmp"
    if root.parent != parent or not root.name.startswith("pi-ide-debuggers-") or root.is_symlink() or root.resolve() != root:
        raise ValueError("Cleanup accepts only an exact private fixture receipt root")
    receipt = json.loads((root / "receipt.json").read_text())
    if receipt["root"] != str(root):
        raise ValueError("Fixture receipt identity differs")
    shutil.rmtree(root)
    print(json.dumps({"removedRoot": str(root), "absent": not root.exists()}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", choices=PACKAGES)
    parser.add_argument("--remove", metavar="RECEIPT_ROOT")
    arguments = parser.parse_args()
    if bool(arguments.group) == bool(arguments.remove):
        parser.error("Choose exactly one --group or --remove")
    if arguments.remove:
        remove(arguments.remove)
    else:
        provision(arguments.group)
