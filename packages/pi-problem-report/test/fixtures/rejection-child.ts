// Runs one rejection scenario in a fresh process and prints what happened as JSON lines.
const { installRejectionGuard } = (await import(process.env.GUARD_MODULE ?? "")) as {
  installRejectionGuard: (options: {
    id: string;
    owns: (reason: unknown) => boolean;
    report: (reason: unknown) => void;
  }) => () => void;
};

const print = (event: string, detail?: unknown): void => {
  process.stdout.write(`${JSON.stringify({ event, detail })}\n`);
};
const reasonText = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

process.on("uncaughtException", (error: Error & { code?: string }) => {
  print("uncaught", { message: error.message, code: error.code });
  process.exit(3);
});

const owns = (reason: unknown): boolean => reasonText(reason).startsWith("OURS");
const report = (reason: unknown): void => print("reported", reasonText(reason));

const scenario = process.argv[2];
if (scenario === "owned") {
  installRejectionGuard({ id: "sample", owns, report });
  void Promise.reject(new Error("OURS failed"));
} else if (scenario === "foreign") {
  installRejectionGuard({ id: "sample", owns, report });
  void Promise.reject(new Error("FOREIGN failed"));
} else if (scenario === "foreign-value") {
  installRejectionGuard({ id: "sample", owns, report });
  // oxlint-disable-next-line prefer-promise-reject-errors -- the scenario needs a non-error reason
  void Promise.reject("FOREIGN value");
} else if (scenario === "foreign-with-listener") {
  installRejectionGuard({ id: "sample", owns, report });
  process.on("unhandledRejection", (reason) => print("other-listener", reasonText(reason)));
  void Promise.reject(new Error("FOREIGN failed"));
} else if (scenario === "reinstall") {
  installRejectionGuard({ id: "sample", owns: () => false, report });
  const remove = installRejectionGuard({ id: "sample", owns, report });
  print("listeners", process.listenerCount("unhandledRejection"));
  void Promise.reject(new Error("OURS after reload"));
  setTimeout(() => {
    remove();
    print("listeners", process.listenerCount("unhandledRejection"));
  }, 50);
} else if (scenario === "stale-remove") {
  const stale = installRejectionGuard({ id: "sample", owns: () => false, report });
  installRejectionGuard({ id: "sample", owns, report });
  stale();
  print("listeners", process.listenerCount("unhandledRejection"));
  void Promise.reject(new Error("OURS still guarded"));
}
setTimeout(() => print("alive"), 100);
