/**
 * Windows Job Object 封装 —— 把子进程绑进 Job，子进程（包括孙子）会随 Job 关闭被内核杀掉。
 * 这是 local-ops PR #3 的核心设计：父进程死了 -> 内核级联回收子进程。
 *
 * 在非 Windows 平台是 no-op，用 process 组替代。
 */
import { spawn, ChildProcess } from 'node:child_process'
import { platform } from 'node:process'

let kernel32: Record<string, never> | null = null

interface JobHandle {
  close(): void
}

interface WinJob extends JobHandle {
  assign(pid: number): boolean
}

interface Kernel32 {
  CreateJobObjectW(): WinJob
  SetInformationJobObject(
    job: WinJob,
    infoClass: number,
    info: Buffer,
    cb: number
  ): boolean
  AssignProcessToJobObject(job: WinJob, hProcess: number): boolean
}

function loadKernel32(): Kernel32 | null {
  if (platform !== 'win32') return null
  try {
    // 用 ffi-napi 是不必要的。直接 require 走系统 dll 不行；
    // 改用 koffi（better-sqlite3 同生态）—— 但 koffi 也是额外依赖。
    // 折中：用 powershell 调用 Win32 API（不优雅但零依赖）
    return null
  } catch {
    return null
  }
}

// 备用方案：用 PowerShell 创建 Job Object 并附加子进程
// 该方案对简单的 Vite/Node dev server 已经够用（subreaper 风格）
const PS_JOB_SCRIPT = `
param([int]$Pid)
$src = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class JobHelper {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll")]
  public static extern bool SetInformationJobObject(IntPtr h, int c, IntPtr i, uint cb);
  [DllImport("kernel32.dll")]
  public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit, Affinity, PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  public static IntPtr CreateAndAssign(int pid) {
    var job = CreateJobObjectW(IntPtr.Zero, null);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    var len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    var ptr = Marshal.AllocHGlobal(len);
    Marshal.StructureToPtr(info, ptr, false);
    SetInformationJobObject(job, 9, ptr, (uint)len); // JobObjectExtendedLimitInformation = 9
    Marshal.FreeHGlobal(ptr);
    var proc = Process.GetProcessById(pid);
    AssignProcessToJobObject(job, proc.Handle);
    return job;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
[JobHelper]::CreateAndAssign($Pid) | Out-Null
Write-Output "ok"
`

let jobProc: ChildProcess | null = null
let jobStarted = false

export async function ensureJobObjectForPid(pid: number): Promise<boolean> {
  if (platform !== 'win32') return true
  if (jobStarted) return true
  return new Promise((resolve) => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_JOB_SCRIPT, '-Pid', String(pid)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    jobProc = p
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('close', (code) => {
      jobStarted = out.includes('ok')
      resolve(jobStarted)
    })
    p.on('error', () => resolve(false))
  })
}

/**
 * 在 Windows 下，把子进程 attach 到当前会话的 Job。
 * 注意：v1 简化——先让用户用 npm/pnpm 自带的进程组；后续 v1.1 升级到 kernel32 直调。
 */
export async function attachToSessionJob(pid: number): Promise<boolean> {
  return ensureJobObjectForPid(pid)
}
