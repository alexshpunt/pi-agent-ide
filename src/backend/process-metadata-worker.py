import datetime
import json
import os
import sys

LIMIT = 4 * 1024 * 1024


def command_text(raw):
    # Debug adapters put short-lived authentication values in argv, not source text.
    protected = {"--adapter-access-token", "--client-access-token", "--server-access-token"}
    arguments = raw.decode("utf-8", errors="replace").split("\0")
    if arguments and not arguments[-1]:
        arguments.pop()
    result = []
    hide_next = False
    for argument in arguments:
        if hide_next:
            result.append("[redacted]")
            hide_next = False
            continue
        name, separator, _value = argument.partition("=")
        if name in protected:
            result.append(name + "=[redacted]" if separator else name)
            hide_next = not separator
        else:
            result.append(argument)
    return " ".join(result)


def inspect(pid, boot, clock, boot_id):
    directory = "/proc/" + str(pid)
    with open(directory + "/stat", encoding="utf-8") as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise OverflowError()
    fields = raw[raw.rfind(")") + 2:].split()
    ticks = int(fields[19])
    with open(directory + "/cmdline", "rb") as stream:
        command = stream.read(LIMIT + 1)
    if len(command) > LIMIT:
        raise OverflowError()
    command = command_text(command)
    if not command:
        command = "[" + raw[raw.find("(") + 1:raw.rfind(")")] + "]"
    try:
        executable = os.readlink(directory + "/exe")
    except (FileNotFoundError, PermissionError):
        executable = None
    # Refuse metadata from a process that disappeared or reused this PID during acquisition.
    with open(directory + "/stat", encoding="utf-8") as stream:
        after = stream.read(LIMIT + 1)
    if after[after.rfind(")") + 2:].split()[19] != str(ticks):
        raise ProcessLookupError()
    return {
        "pid": pid, "parentPid": int(fields[1]), "command": command,
        "started": datetime.datetime.fromtimestamp(boot + ticks / clock, datetime.timezone.utc).isoformat(),
        "identity": boot_id + ":" + str(ticks), "executable": executable,
    }


def main():
    if not os.path.isdir("/proc"):
        return {"error": "CAPABILITY_UNAVAILABLE"}
    with open("/proc/stat", encoding="utf-8") as stream:
        boot = next(int(line.split()[1]) for line in stream if line.startswith("btime "))
    with open("/proc/sys/kernel/random/boot_id", encoding="utf-8") as stream:
        boot_id = stream.read().strip()
    clock = os.sysconf("SC_CLK_TCK")
    selected = int(sys.argv[1]) if len(sys.argv) > 1 else None
    pids = [selected] if selected is not None else sorted(int(name) for name in os.listdir("/proc") if name.isdigit())
    result = []
    size = len('{"processes": []}')
    for pid in pids:
        try:
            item = inspect(pid, boot, clock, boot_id)
            size += len(json.dumps(item, ensure_ascii=True).encode("utf-8")) + 2
            if size > LIMIT:
                raise OverflowError()
            result.append(item)
        except (FileNotFoundError, ProcessLookupError):
            if selected is not None:
                return {"error": "ENOENT"}
        except PermissionError:
            if selected is not None:
                return {"error": "EACCES"}
    return {"processes": result}


try:
    output = json.dumps(main(), ensure_ascii=True)
    if len(output.encode("utf-8")) > LIMIT:
        output = json.dumps({"error": "BYTE_LIMIT"})
except OverflowError:
    output = json.dumps({"error": "BYTE_LIMIT"})
except (OSError, ValueError, IndexError, StopIteration):
    output = json.dumps({"error": "CAPABILITY_UNAVAILABLE"})
print(output)
