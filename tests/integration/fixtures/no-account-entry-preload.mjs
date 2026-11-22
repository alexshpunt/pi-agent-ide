// Makes the account lookup fail like a process whose user has no /etc/passwd entry.
import os from "node:os";

os.userInfo = () => {
  throw Object.assign(
    new Error("A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)"),
    { code: "ERR_SYSTEM_ERROR", errno: -2, syscall: "uv_os_get_passwd" },
  );
};
