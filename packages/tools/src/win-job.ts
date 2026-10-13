import { dlopen, FFIType } from "bun:ffi";

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

let kernel32: ReturnType<typeof openKernel32> | undefined;
const jobs = new Map<number, NonNullable<ReturnType<ReturnType<typeof openKernel32>["CreateJobObjectW"]>>>();

/**
 * Puts a new process into a Windows job object of its own, until `exited` settles. `taskkill /T` follows parent
 * links, and a program of Git Bash (MSYS) has a parent that is already gone: only the job holds every descendant.
 */
export function trackJob(pid: number, exited: Promise<unknown>): void {
  if (process.platform !== "win32") return;
  try {
    kernel32 ??= openKernel32();
    const job = kernel32.CreateJobObjectW(null, null);
    const handle = kernel32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
    if (job === null || handle === null) return;
    const assigned = kernel32.AssignProcessToJobObject(job, handle);
    kernel32.CloseHandle(handle);
    if (assigned === 0) {
      kernel32.CloseHandle(job);
      return;
    }
    jobs.set(pid, job);
    const release = (): void => {
      if (jobs.get(pid) !== job) return;
      jobs.delete(pid);
      kernel32?.CloseHandle(job);
    };
    void exited.then(release, release);
  } catch {
    // No job: the tree kill of the caller still runs.
  }
}

/** Stops every process of the job of `pid`. No job (not Windows, or the job could not be made) is no action. */
export function killJob(pid: number): void {
  const job = jobs.get(pid);
  if (job === undefined) return;
  try {
    kernel32?.TerminateJobObject(job, 1);
  } catch {}
}
