import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The hidden command of the binary that runs one command under the restricted token. */
export const SANDBOX_COMMAND = "__sandbox";

const STANDALONE = /^(B:[\\/]~BUN|\/\$bunfs)[\\/]/.test(Bun.main);

/** The argv of the helper process. It must be a process of its own: it waits for the command in a blocking call. */
export function windowsSandboxHelper(): string[] {
  if (STANDALONE) return [process.execPath, SANDBOX_COMMAND];
  return [process.execPath, "run", join(import.meta.dir, "sandbox-win-entry.ts")];
}

/**
 * The SID that the restricted token of a workspace holds: one for each workspace, so that a command in one
 * workspace cannot write in another. It gives no right that the user does not have.
 */
export function windowsSandboxSid(root: string): string {
  const hash = createHash("sha256").update(root.replace(/\//g, "\\").toLowerCase()).digest();
  return `S-1-5-21-${hash.readUInt32LE(0)}-${hash.readUInt32LE(4)}-${hash.readUInt32LE(8)}-1001`;
}

/** The temporary folder of the commands of a workspace: the user's own temporary folder is not writable. */
export function windowsSandboxTemp(sid: string): string {
  return join(tmpdir(), "agency-sandbox", sid);
}

/** One argument in the quoting of the C runtime, the same as Bun.spawn: the child reads back the same argv. */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes += 1;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * Lets the SID write in the workspace and the temporary folder, and not in `.git/hooks`: a hook that a command
 * writes would run later outside the sandbox. The rules stay on the folders; a second call changes nothing.
 */
export async function prepareWindowsSandbox(root: string, sid: string): Promise<boolean> {
  const temp = windowsSandboxTemp(sid);
  mkdirSync(temp, { recursive: true });
  return addAccessRules(sid, [
    `Add-Rule ${psQuote(root)} 'Modify' 'Allow'`,
    `Add-Rule ${psQuote(temp)} 'Modify' 'Allow'`,
    `$hooks = Join-Path ${psQuote(root)} '.git\\hooks'`,
    "if (Test-Path -LiteralPath $hooks) { Add-Rule $hooks 'Write, Delete, DeleteSubdirectoriesAndFiles' 'Deny' }",
  ]);
}

/** Lets the script container read and run the files of the runner: of the user's disk, it sees only these. */
export async function prepareScriptContainer(readPaths: string[]): Promise<boolean> {
  const sid = scriptContainerSidText();
  if (sid === undefined) return false;
  return addAccessRules(
    sid,
    readPaths.map((path) => `Add-Rule ${psQuote(path)} 'ReadAndExecute' 'Allow'`),
  );
}

/** Runs `Add-Rule <path> <rights> <type>` lines for one SID. A rule that is there already is not added again. */
async function addAccessRules(sid: string, lines: string[]): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$sid = New-Object System.Security.Principal.SecurityIdentifier ${psQuote(sid)}`,
    "function Add-Rule($path, $rights, $type) {",
    "  $item = Get-Item -LiteralPath $path -Force",
    "  $acl = $item.GetAccessControl('Access')",
    "  $has = $acl.Access | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and $_.AccessControlType -eq $type }",
    "  if ($has) { return }",
    "  $inherit = if ($item.PSIsContainer) { 'ContainerInherit,ObjectInherit' } else { 'None' }",
    "  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, 'None', $type)))",
    "  $item.SetAccessControl($acl)",
    "}",
    ...lines,
  ].join("\n");
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-Command", script], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

function openApis() {
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },
    SetHandleInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ResumeThread: { args: [FFIType.ptr], returns: FFIType.u32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    InitializeProcThreadAttributeList: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UpdateProcThreadAttribute: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  }).symbols;
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    CreateRestrictedToken: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    ConvertStringSidToSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    InitializeAcl: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    AddAccessAllowedAce: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SetTokenInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    SetSecurityInfo: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
    CreateProcessAsUserW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  }).symbols;
  return { kernel32, advapi32 };
}

const TOKEN_ACCESS = 0x0001 | 0x0002 | 0x0008 | 0x0080 | 0x0100 | 0x40000;
const WRITE_RESTRICTED = 0x8;
const DISABLE_MAX_PRIVILEGE = 0x1;
const SE_GROUP_LOGON_ID = 0xc0000000;
const GENERIC_ALL = 0x10000000;
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x20009n;

const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");
const pinned: Uint8Array[] = [];

/**
 * Runs `argv` under a write-restricted token. Without `Everyone`, `RESTRICTED` and the logon SID, the NUL device and
 * named objects refuse it; MSYS refuses it even with them. The job kills the command when this process dies.
 */
export function runRestricted(sid: string, argv: string[]): number {
  const { kernel32, advapi32 } = openApis();
  const fail = (what: string): number => {
    process.stderr.write(`agency sandbox: ${what} failed (Windows error ${kernel32.GetLastError()})\n`);
    return 125;
  };
  const program = argv[0] === undefined ? undefined : (Bun.which(argv[0]) ?? undefined);
  if (program === undefined) {
    process.stderr.write(`agency sandbox: command not found: ${argv[0] ?? ""}\n`);
    return 127;
  }

  const tokenOut = new BigUint64Array(1);
  if (!advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_ACCESS, ptr(tokenOut))) {
    return fail("OpenProcessToken");
  }
  const token = Number(tokenOut[0]) as Pointer;
  const tokenInfo = (kind: number): DataView => {
    const size = new Uint32Array(1);
    advapi32.GetTokenInformation(token, kind, null, 0, ptr(size));
    const bytes = new Uint8Array(size[0] ?? 0);
    advapi32.GetTokenInformation(token, kind, ptr(bytes), bytes.length, ptr(size));
    // The SIDs are pointers into this buffer: the collector must not free it while Windows reads them.
    pinned.push(bytes);
    return new DataView(bytes.buffer);
  };
  // TOKEN_USER: the SID pointer first. TOKEN_GROUPS: a count, then SID_AND_ATTRIBUTES of 16 bytes from offset 8.
  const userSid = Number(tokenInfo(1).getBigUint64(0, true));
  const groups = tokenInfo(2);
  let logonSid = 0;
  for (let i = 0; i < groups.getUint32(0, true); i++) {
    if ((groups.getUint32(16 + i * 16, true) & SE_GROUP_LOGON_ID) === SE_GROUP_LOGON_ID) {
      logonSid = Number(groups.getBigUint64(8 + i * 16, true));
    }
  }
  const sidOf = (text: string): number => {
    const out = new BigUint64Array(1);
    return advapi32.ConvertStringSidToSidW(ptr(wide(text)), ptr(out)) ? Number(out[0]) : 0;
  };
  const restricting = [sidOf(sid), sidOf("S-1-1-0"), sidOf("S-1-5-12"), ...(logonSid ? [logonSid] : [])];
  if (restricting.includes(0)) return fail("ConvertStringSidToSidW");
  const sidList = new Uint8Array(16 * restricting.length);
  for (const [i, s] of restricting.entries())
    new DataView(sidList.buffer).setBigUint64(i * 16, BigInt(s), true);
  const restrictedOut = new BigUint64Array(1);
  if (
    !advapi32.CreateRestrictedToken(
      token,
      WRITE_RESTRICTED | DISABLE_MAX_PRIVILEGE,
      0,
      null,
      0,
      null,
      restricting.length,
      ptr(sidList),
      ptr(restrictedOut),
    )
  ) {
    return fail("CreateRestrictedToken");
  }
  const restricted = Number(restrictedOut[0]) as Pointer;

  // The objects that the command makes, and the token itself, must also pass the check of the restricted SIDs.
  const acl = new Uint8Array(1024);
  if (!advapi32.InitializeAcl(ptr(acl), acl.length, 2)) return fail("InitializeAcl");
  for (const s of [userSid, sidOf("S-1-5-18"), ...restricting.filter((s) => s !== restricting[1])]) {
    if (!advapi32.AddAccessAllowedAce(ptr(acl), 2, GENERIC_ALL, s as unknown as Pointer)) {
      return fail("AddAccessAllowedAce");
    }
  }
  const defaultDacl = new BigUint64Array([BigInt(ptr(acl))]);
  if (!advapi32.SetTokenInformation(restricted, 6, ptr(defaultDacl), 8)) return fail("SetTokenInformation");
  advapi32.SetSecurityInfo(restricted, 6, 4, null, null, ptr(acl), null);

  const startup = startupWithStdHandles(kernel32, 104);
  const info = new Uint8Array(24);
  const commandLine = [program, ...argv.slice(1)].map(quoteWindowsArg).join(" ");
  // The user's own temporary folder is not writable: the command gets the folder of the SID.
  const temp = windowsSandboxTemp(sid);
  const env: Record<string, string | undefined> = { ...process.env, TEMP: temp, TMP: temp };
  const block = Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()))
    .map((name) => `${name}=${env[name]}\0`)
    .join("");
  if (
    !advapi32.CreateProcessAsUserW(
      restricted,
      ptr(wide(program)),
      ptr(wide(commandLine)),
      null,
      null,
      1,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      ptr(wide(block)),
      null,
      ptr(startup),
      ptr(info),
    )
  ) {
    return fail("CreateProcessAsUserW");
  }
  return runInJob(kernel32, info, fail);
}

/** STARTUPINFOW (104 bytes) or STARTUPINFOEXW (112): the command gets the standard handles of this process. */
function startupWithStdHandles(
  kernel32: ReturnType<typeof openApis>["kernel32"],
  size: 104 | 112,
): Uint8Array {
  const startup = new Uint8Array(size);
  const view = new DataView(startup.buffer);
  view.setUint32(0, size, true);
  view.setUint32(60, 0x100, true);
  for (const [offset, which] of [
    [80, -10],
    [88, -11],
    [96, -12],
  ] as const) {
    const handle = kernel32.GetStdHandle(which >>> 0);
    if (handle) kernel32.SetHandleInformation(handle, 1, 1);
    view.setBigUint64(offset, BigInt(handle ?? 0), true);
  }
  return startup;
}

/** Puts the suspended child of PROCESS_INFORMATION in a job, starts it, and returns its exit code. */
function runInJob(
  kernel32: ReturnType<typeof openApis>["kernel32"],
  info: Uint8Array,
  fail: (what: string) => number,
): number {
  const infoView = new DataView(info.buffer);
  const child = Number(infoView.getBigUint64(0, true)) as Pointer;
  const thread = Number(infoView.getBigUint64(8, true)) as Pointer;
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes), LimitFlags at offset 16.
  const job = kernel32.CreateJobObjectW(null, null);
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (
    job === null ||
    !kernel32.SetInformationJobObject(job, 9, ptr(limits), limits.length) ||
    !kernel32.AssignProcessToJobObject(job, child)
  ) {
    // Not one process of the command may run outside the job: it would outlive a cancel.
    kernel32.TerminateProcess(child, 1);
    return fail("AssignProcessToJobObject");
  }
  kernel32.ResumeThread(thread);
  kernel32.WaitForSingleObject(child, 0xffffffff);
  const code = new Uint32Array(1);
  kernel32.GetExitCodeProcess(child, ptr(code));
  return code[0] ?? 1;
}

/** The mode word of the helper for a script: in place of a SID, `<helper> appcontainer -- <argv...>`. */
export const APPCONTAINER_MODE = "appcontainer";
/** The AppContainer of the scripts of the `code` tool. With no capability it has no network and no user files. */
const SCRIPT_CONTAINER = "agency.script";

function openContainerApis() {
  return dlopen("userenv.dll", {
    CreateAppContainerProfile: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    DeriveAppContainerSidFromAppContainerName: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

/** The SID of the script container; the profile is made on first use and stays. */
function scriptContainerSid(): number | undefined {
  const userenv = openContainerApis();
  const name = wide(SCRIPT_CONTAINER);
  const out = new BigUint64Array(1);
  if (userenv.CreateAppContainerProfile(ptr(name), ptr(name), ptr(name), null, 0, ptr(out)) === 0) {
    return Number(out[0]);
  }
  return userenv.DeriveAppContainerSidFromAppContainerName(ptr(name), ptr(out)) === 0
    ? Number(out[0])
    : undefined;
}

/** The SID of the script container as text, for an access rule. */
export function scriptContainerSidText(): string | undefined {
  const sid = scriptContainerSid();
  if (sid === undefined) return undefined;
  const advapi32 = dlopen("advapi32.dll", {
    ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const out = new BigUint64Array(1);
  if (!advapi32.ConvertSidToStringSidW(sid as unknown as Pointer, ptr(out))) return undefined;
  const chars = new Uint16Array(toArrayBuffer(Number(out[0]) as Pointer, 0, 512));
  const end = chars.indexOf(0);
  return String.fromCharCode(...chars.subarray(0, end === -1 ? chars.length : end));
}

/** Runs `argv` in the script container, in a job that ends with this process. */
export function runInAppContainer(argv: string[]): number {
  const { kernel32 } = openApis();
  const fail = (what: string): number => {
    process.stderr.write(`agency sandbox: ${what} failed (Windows error ${kernel32.GetLastError()})\n`);
    return 125;
  };
  const program = argv[0] === undefined ? undefined : (Bun.which(argv[0]) ?? undefined);
  if (program === undefined) {
    process.stderr.write(`agency sandbox: command not found: ${argv[0] ?? ""}\n`);
    return 127;
  }
  const sid = scriptContainerSid();
  if (sid === undefined) return fail("CreateAppContainerProfile");
  // SECURITY_CAPABILITIES: the container SID, then no capabilities.
  const capabilities = new Uint8Array(24);
  new DataView(capabilities.buffer).setBigUint64(0, BigInt(sid), true);
  const size = new BigUint64Array(1);
  kernel32.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
  const list = new Uint8Array(Number(size[0]));
  // Windows reads both through the pointers in STARTUPINFOEX, after the last use of these names.
  pinned.push(capabilities, list);
  if (!kernel32.InitializeProcThreadAttributeList(ptr(list), 1, 0, ptr(size))) {
    return fail("InitializeProcThreadAttributeList");
  }
  if (
    !kernel32.UpdateProcThreadAttribute(
      ptr(list),
      0,
      PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
      ptr(capabilities),
      24n,
      null,
      null,
    )
  ) {
    return fail("UpdateProcThreadAttribute");
  }
  const startup = startupWithStdHandles(kernel32, 112);
  new DataView(startup.buffer).setBigUint64(104, BigInt(ptr(list)), true);
  const info = new Uint8Array(24);
  const commandLine = [program, ...argv.slice(1)].map(quoteWindowsArg).join(" ");
  if (
    !kernel32.CreateProcessW(
      ptr(wide(program)),
      ptr(wide(commandLine)),
      null,
      null,
      1,
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
      null,
      null,
      ptr(startup),
      ptr(info),
    )
  ) {
    return fail("CreateProcessW");
  }
  return runInJob(kernel32, info, fail);
}

/** The helper process: `<helper> <sid> -- <argv...>`, or `<helper> appcontainer -- <argv...>` for a script. */
export function runSandboxChild(): never {
  const separator = process.argv.indexOf("--");
  const mode = process.argv[separator - 1] ?? "";
  const argv = process.argv.slice(separator + 1);
  process.exit(mode === APPCONTAINER_MODE ? runInAppContainer(argv) : runRestricted(mode, argv));
}
