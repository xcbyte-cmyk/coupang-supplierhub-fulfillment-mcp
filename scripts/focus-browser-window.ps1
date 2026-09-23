param(
    [int]$ProcessId = 0,
    [switch]$SplitWithDashboard,
    [switch]$PrepareWorkspace
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.IO;

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

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo {
        public int Size;
        public Rect Monitor, Work;
        public uint Flags;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int length);

    public sealed class LayoutResult {
        public string code;
        public int moved, matched, left, top, width, height;
    }

    public static LayoutResult PrepareWorkspace(uint[] browserProcesses, string[] documents) {
        SetProcessDPIAware();
        IntPtr dashboard = IntPtr.Zero;
        var foreground = GetForegroundWindow();
        var targets = new List<IntPtr>();
        EnumWindows((window, _) => {
            if (!IsWindowVisible(window)) return true;
            if (IsDashboard(window)) {
                if (dashboard == IntPtr.Zero || window == foreground) dashboard = window;
                return true;
            }
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            // Native print/confirmation dialogs retain their calibrated position.
            if (className.ToString() == "#32770") return true;
            var titleBuffer = new StringBuilder(1024);
            GetWindowText(window, titleBuffer, titleBuffer.Capacity);
            var title = titleBuffer.ToString();
            if (title.IndexOf("OZ", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Print", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("\uC778\uC1C4", StringComparison.Ordinal) >= 0) return true;
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            bool browser = className.ToString().StartsWith("Chrome_WidgetWin", StringComparison.Ordinal);
            bool knownBrowser = browser && (
                Array.IndexOf(browserProcesses, pid) >= 0 ||
                title.IndexOf("Supplier Hub", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Logen", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("\uB85C\uC820", StringComparison.Ordinal) >= 0);
            bool knownDocument = false;
            foreach (var name in documents) {
                var stem = Path.GetFileNameWithoutExtension(name);
                if (title.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (stem.Length >= 4 && title.IndexOf(stem, StringComparison.OrdinalIgnoreCase) >= 0)) {
                    knownDocument = true;
                    break;
                }
            }
            if (knownBrowser || knownDocument) targets.Add(window);
            return true;
        }, IntPtr.Zero);
        var result = new LayoutResult { code = "dashboard_missing", matched = targets.Count };
        if (dashboard == IntPtr.Zero) return result;
        var monitor = MonitorFromWindow(dashboard, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetMonitorInfo(monitor, ref info)) return result;
        int width = info.Work.Right - info.Work.Left, height = info.Work.Bottom - info.Work.Top;
        if (width < 800 || height < 400) { result.code = "screen_small"; return result; }
        int half = width / 2;
        result.left = info.Work.Left + half;
        result.top = info.Work.Top;
        result.width = width - half;
        result.height = height;
        ShowWindow(dashboard, SW_RESTORE);
        bool success = MoveWindow(dashboard, info.Work.Left, info.Work.Top, half, height, true);
        foreach (var target in targets) {
            ShowWindow(target, SW_RESTORE);
            if (MoveWindow(target, result.left, result.top, result.width, height, true)) result.moved++;
            else success = false;
        }
        result.code = success ? "ready" : "partial";
        return result;
    }

    private static bool IsDashboard(IntPtr window) {
        var title = new StringBuilder(1024);
        GetWindowText(window, title, title.Capacity);
        var text = title.ToString();
        return text.IndexOf("\uBC1C\uC8FC\u00B7\uBC30\uC1A1", StringComparison.Ordinal) >= 0 ||
            text.IndexOf("Supplier Hub Fulfillment", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    // Reuse visible windows only. Never launch, navigate or close a dashboard.
    // If no matching dashboard exists, leave the current window arrangement alone.
    public static bool ArrangeBesideDashboard(uint expectedProcessId) {
        SetProcessDPIAware();
        IntPtr target = IntPtr.Zero, dashboard = IntPtr.Zero;
        var foreground = GetForegroundWindow();
        EnumWindows((window, _) => {
            if (!IsWindowVisible(window)) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == expectedProcessId) {
                if (target == IntPtr.Zero) target = window;
            } else if (IsDashboard(window) && (dashboard == IntPtr.Zero || window == foreground)) {
                dashboard = window;
            }
            return true;
        }, IntPtr.Zero);
        if (target == IntPtr.Zero || dashboard == IntPtr.Zero) return false;
        var monitor = MonitorFromWindow(dashboard, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetMonitorInfo(monitor, ref info)) return false;
        int width = info.Work.Right - info.Work.Left;
        int height = info.Work.Bottom - info.Work.Top;
        if (width < 800 || height < 400) return false;
        int leftWidth = width / 2;
        ShowWindow(dashboard, SW_RESTORE);
        ShowWindow(target, SW_RESTORE);
        bool leftMoved = MoveWindow(dashboard, info.Work.Left, info.Work.Top, leftWidth, height, true);
        bool rightMoved = MoveWindow(target, info.Work.Left + leftWidth, info.Work.Top, width - leftWidth, height, true);
        return leftMoved && rightMoved;
    }

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

if ($PrepareWorkspace) {
    $targets = @{ processes = @(); documents = @() }
    if ($env:SUPPLIERHUB_LAYOUT_TARGETS) {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SUPPLIERHUB_LAYOUT_TARGETS))
        $targets = $json | ConvertFrom-Json
    }
    [BrowserWindowForeground]::PrepareWorkspace([uint32[]]@($targets.processes), [string[]]@($targets.documents)) | ConvertTo-Json -Compress
    exit 0
}
if ($ProcessId -le 0) { throw "ProcessId or PrepareWorkspace is required." }
if ($SplitWithDashboard) {
    $arranged = [BrowserWindowForeground]::ArrangeBesideDashboard([uint32]$ProcessId)
    if (-not $arranged) {
        Write-Output "split_skipped: no matching dashboard window or usable monitor"
    }
}
$activated = [BrowserWindowForeground]::Activate([uint32]$ProcessId)
if (-not $activated) {
    exit 1
}
