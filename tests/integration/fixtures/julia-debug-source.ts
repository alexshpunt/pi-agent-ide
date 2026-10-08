/** Real Julia source shared by native and ordinary debugger verification. */
export const JULIA_DEBUG_SOURCE =
  'function run()\n    value = 42\n    pid = getpid()\n    value = value + 1\n    println("café ", value)\nend\nrun()\n';
