"""Processes that end with this one.

end_with_me() puts the current process in a Windows job object that ends every process in it when this one ends,
however it ends (finished, crashed, stopped, killed). Every process started afterwards joins the job too, and so do
the processes those start. A headless browser or server a tool starts can then never outlive the tool: Edge's
launcher hands over to the browser it spawns and exits, so stopping "the browser's PID" at the end misses it, and a
tool that is stopped mid-run never reaches its own clean-up. Used by the thumbnail service, tools/capture.py and
launcher/make_splash.py. Stdlib only; does nothing outside Windows.
"""
import ctypes
import os

_job = None


def end_with_me():
    """Join a kill-on-close job (once). Returns True when this process is in one."""
    global _job
    if _job is not None:
        return True
    if os.name != 'nt':
        return False
    from ctypes import wintypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.GetCurrentProcess.restype = wintypes.HANDLE

    class Basic(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [('Basic', Basic), ('Io', ctypes.c_uint64 * 6), ('ProcessMemoryLimit', ctypes.c_size_t),
                    ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t),
                    ('PeakJobMemoryUsed', ctypes.c_size_t)]
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return False
    info = Extended()
    info.Basic.LimitFlags = 0x2000                    # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k32.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info)) or \
            not k32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(k32.GetCurrentProcess())):
        k32.CloseHandle(wintypes.HANDLE(job))
        return False
    _job = job                                        # (the handle stays open until this process ends)
    return True
