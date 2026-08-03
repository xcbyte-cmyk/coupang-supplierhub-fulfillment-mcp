param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BrowserWindowForeground {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint sourceThread, uint targetThread, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private const int SW_RESTORE = 9;

    public static bool Activate(uint expectedProcessId) {
        IntPtr target = IntPtr.Zero;
        EnumWindows((window, _) => {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == expectedProcessId && IsWindowVisible(window)) {
                target = window;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (target == IntPtr.Zero) return false;

        ShowWindowAsync(target, SW_RESTORE);
        uint ignoredProcessId;
        var targetThread = GetWindowThreadProcessId(target, out ignoredProcessId);
        var currentThread = GetCurrentThreadId();
        var foreground = GetForegroundWindow();
        var foregroundThread = foreground == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(foreground, out ignoredProcessId);

        var attachedToTarget = currentThread == targetThread ||
            AttachThreadInput(currentThread, targetThread, true);
        var attachedToForeground = foregroundThread == 0 ||
            foregroundThread == currentThread ||
            foregroundThread == targetThread ||
            AttachThreadInput(currentThread, foregroundThread, true);

        try {
            BringWindowToTop(target);
            SetActiveWindow(target);
            SetForegroundWindow(target);
            return GetForegroundWindow() == target;
        }
        finally {
            if (attachedToForeground && foregroundThread != 0 &&
                foregroundThread != currentThread && foregroundThread != targetThread) {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
            if (attachedToTarget && currentThread != targetThread) {
                AttachThreadInput(currentThread, targetThread, false);
            }
        }
    }
}
'@

$activated = [BrowserWindowForeground]::Activate([uint32]$ProcessId)
if (-not $activated) {
    exit 1
}
