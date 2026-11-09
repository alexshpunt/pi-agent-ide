"""Convert canonical remote paths at the Windows target boundary.

The host names Windows files as `/C:/Users/name`; Windows APIs receive `C:\\Users\\name`.
"""


class InvalidPath(ValueError):
    pass


def windows_native(path):
    if not (isinstance(path, str) and len(path) >= 3 and path[0] == "/" and path[1].isalpha()
            and path[2] == ":" and (len(path) == 3 or path[3] == "/") and "\0" not in path):
        raise InvalidPath(path)
    return path[1:3] + "\\" + path[4:].replace("/", "\\")


def windows_wire(path):
    if path.startswith("\\\\?\\"):
        path = path[4:]
    if len(path) < 2 or not path[0].isalpha() or path[1] != ":":
        raise InvalidPath(path)
    return "/" + path[0].upper() + ":" + ("/" + path[3:].replace("\\", "/") if len(path) > 3 else "/")
