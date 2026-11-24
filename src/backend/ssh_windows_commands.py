"""Resolve Windows executable and shim paths without adding the current directory."""
import ntpath
import os
import re

DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"


def _at_cwd(path, cwd):
    if re.match(r"^/[a-zA-Z]:/", path):
        path = path[1:]
    drive, tail = ntpath.splitdrive(path)
    if drive and not tail.startswith(("/", "\\")):
        # A drive-relative path can only use the requested project drive's cwd.
        if drive.lower() != ntpath.splitdrive(cwd)[0].lower():
            return None
        path = tail
    return ntpath.normpath(ntpath.join(cwd, path))


def find_executable(command, cwd, environment):
    """Resolve explicit paths from cwd, or bare names from PATH and PATHEXT.

    cwd is native; environment keys use Windows' case-insensitive convention (uppercase).
    """
    if not command or "\0" in command:
        return None
    extensions = tuple(
        ext for ext in (environment.get("PATHEXT") or DEFAULT_PATHEXT).split(";") if ext.startswith(".")
    )
    known_extensions = {ext.lower() for ext in (*extensions, *DEFAULT_PATHEXT.split(";"))}
    explicit = bool(ntpath.dirname(command))
    if explicit:
        paths = (_at_cwd(command, cwd),)
    else:
        entries = (entry.strip('"') for entry in environment.get("PATH", "").split(";"))
        paths = (
            _at_cwd(ntpath.join(entry, command), cwd)
            for entry in entries if entry
        )
    for path in paths:
        if path is None:
            continue
        if (explicit or ntpath.splitext(path)[1].lower() in known_extensions) and os.path.isfile(path):
            return path
        for extension in extensions:
            candidate = path + extension
            if os.path.isfile(candidate):
                return candidate
    return None
