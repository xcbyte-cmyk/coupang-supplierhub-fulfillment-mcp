[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Inspect', 'PrepareDefault', 'RestoreDefault', 'Configure', 'Probe', 'Confirm')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$PrinterName,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 100)]
    [int]$ExpectedCount,

    [ValidateRange(1, 60)]
    [int]$TimeoutSeconds = 15,

    [string]$RestorePrinterName
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class NativeWindowInfo {
    public long Handle { get; set; }
    public long Parent { get; set; }
    public string Text { get; set; }
    public string ClassName { get; set; }
    public uint ProcessId { get; set; }
    public bool Visible { get; set; }
    public bool Enabled { get; set; }
}

public static class NativeWindowTree {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetFocus();

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint sourceThread, uint targetThread, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    private static extern IntPtr SendMessageText(IntPtr hWnd, uint message, IntPtr wParam, StringBuilder lParam);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetDefaultPrinter(StringBuilder printerName, ref int bufferSize);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDefaultPrinter(string printerName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    private const uint BM_CLICK = 0x00F5;
    private const uint WM_COMMAND = 0x0111;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint CB_GETCOUNT = 0x0146;
    private const uint CB_GETCURSEL = 0x0147;
    private const uint CB_GETLBTEXT = 0x0148;
    private const uint CB_GETLBTEXTLEN = 0x0149;
    private const uint CB_SETCURSEL = 0x014E;
    private const uint CB_SHOWDROPDOWN = 0x014F;
    private const int CBN_SELCHANGE = 1;
    private const int CBN_CLOSEUP = 8;
    private const int CBN_SELENDOK = 9;
    private const int MK_LBUTTON = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint GA_ROOT = 2;
    private const byte VK_SPACE = 0x20;
    private const byte VK_RETURN = 0x0D;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static NativeWindowInfo Read(IntPtr handle) {
        var text = new StringBuilder(4096);
        GetWindowText(handle, text, text.Capacity);
        var className = new StringBuilder(512);
        GetClassName(handle, className, className.Capacity);
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        return new NativeWindowInfo {
            Handle = handle.ToInt64(),
            Parent = GetParent(handle).ToInt64(),
            Text = text.ToString(),
            ClassName = className.ToString(),
            ProcessId = processId,
            Visible = IsWindowVisible(handle),
            Enabled = IsWindowEnabled(handle)
        };
    }

    public static NativeWindowInfo[] Enumerate() {
        var results = new List<NativeWindowInfo>();
        EnumWindows((top, _) => {
            results.Add(Read(top));
            EnumChildWindows(top, (child, __) => {
                results.Add(Read(child));
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return results.ToArray();
    }

    public static bool Click(long handle) {
        var ptr = new IntPtr(handle);
        if (!IsWindow(ptr) || !IsWindowEnabled(ptr)) return false;
        SendMessage(ptr, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        return true;
    }

    private static bool PrinterNameMatches(string actual, string expected) {
        if (String.IsNullOrWhiteSpace(actual) || String.IsNullOrWhiteSpace(expected)) return false;
        actual = actual.Trim();
        expected = expected.Trim();
        return String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase) ||
            actual.EndsWith(expected, StringComparison.OrdinalIgnoreCase) ||
            expected.EndsWith(actual, StringComparison.OrdinalIgnoreCase);
    }

    public static bool SelectComboItem(long handle, string expected) {
        var combo = new IntPtr(handle);
        if (!IsWindow(combo) || !IsWindowEnabled(combo)) return false;

        var className = new StringBuilder(128);
        GetClassName(combo, className, className.Capacity);
        if (!String.Equals(className.ToString(), "ComboBox", StringComparison.OrdinalIgnoreCase)) {
            return false;
        }

        var count = SendMessage(combo, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (count <= 0 || count > 1024) return false;

        var selectedIndex = -1;
        for (var index = 0; index < count; index += 1) {
            var length = SendMessage(combo, CB_GETLBTEXTLEN, new IntPtr(index), IntPtr.Zero).ToInt32();
            if (length < 0 || length > 4096) continue;
            var value = new StringBuilder(length + 2);
            SendMessageText(combo, CB_GETLBTEXT, new IntPtr(index), value);
            if (PrinterNameMatches(value.ToString(), expected)) {
                selectedIndex = index;
                break;
            }
        }
        if (selectedIndex < 0) return false;

        var root = GetAncestor(combo, GA_ROOT);
        if (root != IntPtr.Zero) {
            BringWindowToTop(root);
            SetForegroundWindow(root);
        }
        SetFocus(combo);
        SendMessage(combo, CB_SHOWDROPDOWN, new IntPtr(1), IntPtr.Zero);
        var result = SendMessage(combo, CB_SETCURSEL, new IntPtr(selectedIndex), IntPtr.Zero).ToInt32();
        if (result != selectedIndex) return false;

        var parent = GetParent(combo);
        if (parent != IntPtr.Zero) {
            var controlId = GetDlgCtrlID(combo) & 0xffff;
            SendMessage(parent, WM_COMMAND, new IntPtr((CBN_SELCHANGE << 16) | controlId), combo);
            SendMessage(parent, WM_COMMAND, new IntPtr((CBN_SELENDOK << 16) | controlId), combo);
            SendMessage(parent, WM_COMMAND, new IntPtr((CBN_CLOSEUP << 16) | controlId), combo);
        }
        SendMessage(combo, CB_SHOWDROPDOWN, IntPtr.Zero, IntPtr.Zero);
        System.Threading.Thread.Sleep(150);

        var currentIndex = SendMessage(combo, CB_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt32();
        return currentIndex == selectedIndex;
    }

    public static string ReadSelectedComboItem(long handle) {
        var combo = new IntPtr(handle);
        if (!IsWindow(combo)) return String.Empty;

        var className = new StringBuilder(128);
        GetClassName(combo, className, className.Capacity);
        if (!String.Equals(className.ToString(), "ComboBox", StringComparison.OrdinalIgnoreCase)) {
            return String.Empty;
        }

        var selectedIndex = SendMessage(combo, CB_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (selectedIndex < 0) return String.Empty;
        var length = SendMessage(combo, CB_GETLBTEXTLEN, new IntPtr(selectedIndex), IntPtr.Zero).ToInt32();
        if (length < 0 || length > 4096) return String.Empty;
        var value = new StringBuilder(length + 2);
        SendMessageText(combo, CB_GETLBTEXT, new IntPtr(selectedIndex), value);
        return value.ToString();
    }

    public static string[] ReadComboItems(long handle) {
        var combo = new IntPtr(handle);
        if (!IsWindow(combo)) return new string[0];
        var count = SendMessage(combo, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (count <= 0 || count > 1024) return new string[0];
        var values = new List<string>();
        for (var index = 0; index < count; index += 1) {
            var length = SendMessage(combo, CB_GETLBTEXTLEN, new IntPtr(index), IntPtr.Zero).ToInt32();
            if (length < 0 || length > 4096) continue;
            var value = new StringBuilder(length + 2);
            SendMessageText(combo, CB_GETLBTEXT, new IntPtr(index), value);
            values.Add(value.ToString());
        }
        return values.ToArray();
    }

    public static string ReadDefaultPrinter() {
        var bufferSize = 0;
        GetDefaultPrinter(null, ref bufferSize);
        if (bufferSize <= 0) return String.Empty;
        var value = new StringBuilder(bufferSize);
        return GetDefaultPrinter(value, ref bufferSize) ? value.ToString() : String.Empty;
    }

    public static bool ChangeDefaultPrinter(string printerName) {
        return !String.IsNullOrWhiteSpace(printerName) && SetDefaultPrinter(printerName.Trim());
    }

    public static bool Exists(long handle) {
        return IsWindow(new IntPtr(handle));
    }

    public static bool Activate(long handle) {
        var ptr = new IntPtr(handle);
        return IsWindow(ptr) && SetForegroundWindow(ptr);
    }

    public static bool ClickAt(int x, int y) {
        if (!SetCursorPos(x, y)) return false;
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        return true;
    }

    public static bool SendDialogCommand(long dialogHandle, long buttonHandle, int expectedControlId) {
        var dialog = new IntPtr(dialogHandle);
        var button = new IntPtr(buttonHandle);
        if (!IsWindow(dialog) || !IsWindow(button) || !IsWindowEnabled(button)) return false;
        if (GetParent(button) != dialog || GetDlgCtrlID(button) != expectedControlId) return false;
        SetForegroundWindow(dialog);
        SendMessage(dialog, WM_COMMAND, new IntPtr(expectedControlId), button);
        return true;
    }

    public static bool ClickButtonClient(long dialogHandle, long buttonHandle, int expectedControlId) {
        var dialog = new IntPtr(dialogHandle);
        var button = new IntPtr(buttonHandle);
        if (!IsWindow(dialog) || !IsWindow(button) || !IsWindowEnabled(button)) return false;
        if (GetParent(button) != dialog || GetDlgCtrlID(button) != expectedControlId) return false;
        NativeRect rect;
        if (!GetClientRect(button, out rect)) return false;
        var x = Math.Max(1, (rect.Right - rect.Left) / 2);
        var y = Math.Max(1, (rect.Bottom - rect.Top) / 2);
        var packed = new IntPtr((y << 16) | (x & 0xffff));
        SendMessage(button, WM_LBUTTONDOWN, new IntPtr(MK_LBUTTON), packed);
        SendMessage(button, WM_LBUTTONUP, IntPtr.Zero, packed);
        return true;
    }

    public static bool PressFocusedButton(long dialogHandle, long buttonHandle, int expectedControlId) {
        var dialog = new IntPtr(dialogHandle);
        var button = new IntPtr(buttonHandle);
        if (!IsWindow(dialog) || !IsWindow(button) || !IsWindowEnabled(button)) return false;
        if (GetParent(button) != dialog || GetDlgCtrlID(button) != expectedControlId) return false;

        uint processId;
        var targetThread = GetWindowThreadProcessId(dialog, out processId);
        var currentThread = GetCurrentThreadId();
        uint foregroundProcessId;
        var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundProcessId);
        var attachedToTarget = currentThread == targetThread || AttachThreadInput(currentThread, targetThread, true);
        var attachedToForeground = currentThread == foregroundThread || targetThread == foregroundThread ||
            AttachThreadInput(currentThread, foregroundThread, true);
        if (!attachedToTarget || !attachedToForeground) {
            if (attachedToTarget && currentThread != targetThread) {
                AttachThreadInput(currentThread, targetThread, false);
            }
            return false;
        }

        try {
            BringWindowToTop(dialog);
            SetForegroundWindow(dialog);
            SetActiveWindow(dialog);
            if (GetForegroundWindow() != dialog) return false;
            System.Threading.Thread.Sleep(150);
            keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
            keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            return true;
        }
        finally {
            if (currentThread != foregroundThread && targetThread != foregroundThread) {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
            if (currentThread != targetThread) {
                AttachThreadInput(currentThread, targetThread, false);
            }
        }
    }

    public static bool ClickButtonOnScreen(long dialogHandle, long buttonHandle, int expectedControlId) {
        var dialog = new IntPtr(dialogHandle);
        var button = new IntPtr(buttonHandle);
        if (!IsWindow(dialog) || !IsWindow(button) || !IsWindowEnabled(button)) return false;
        if (GetParent(button) != dialog || GetDlgCtrlID(button) != expectedControlId) return false;

        var previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            NativeRect rect;
            if (!GetWindowRect(button, out rect)) return false;
            var x = rect.Left + Math.Max(1, (rect.Right - rect.Left) / 2);
            var y = rect.Top + Math.Max(1, (rect.Bottom - rect.Top) / 2);
            if (!SetCursorPos(x, y)) return false;
            System.Threading.Thread.Sleep(100);
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            return true;
        }
        finally {
            if (previousDpiContext != IntPtr.Zero) {
                SetThreadDpiAwarenessContext(previousDpiContext);
            }
        }
    }
}
'@

$PrintWindowTitle = -join @([char]0xC778, [char]0xC1C4)
$ConfirmButtonName = -join @([char]0xD655, [char]0xC778)

function Get-AutomationText {
    param([System.Windows.Automation.AutomationElement]$Element)

    $values = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($Element.Current.Name)) {
        $values.Add($Element.Current.Name.Trim())
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern(
            [System.Windows.Automation.ValuePattern]::Pattern,
            [ref]$pattern
        )) {
        $value = ([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $values.Add($value.Trim())
        }
    }

    $selectionPattern = $null
    if ($Element.TryGetCurrentPattern(
            [System.Windows.Automation.SelectionPattern]::Pattern,
            [ref]$selectionPattern
        )) {
        foreach ($selected in ([System.Windows.Automation.SelectionPattern]$selectionPattern).Current.GetSelection()) {
            if (-not [string]::IsNullOrWhiteSpace($selected.Current.Name)) {
                $values.Add($selected.Current.Name.Trim())
            }
        }
    }

    return @($values | Select-Object -Unique)
}

function Test-PrinterNameMatch {
    param(
        [string]$Actual,
        [string]$Expected
    )

    if ([string]::IsNullOrWhiteSpace($Actual) -or [string]::IsNullOrWhiteSpace($Expected)) {
        return $false
    }
    $actualName = $Actual.Trim()
    $expectedName = $Expected.Trim()
    return $actualName.Equals($expectedName, [System.StringComparison]::OrdinalIgnoreCase) -or
        $actualName.EndsWith($expectedName, [System.StringComparison]::OrdinalIgnoreCase) -or
        $expectedName.EndsWith($actualName, [System.StringComparison]::OrdinalIgnoreCase)
}

function Set-AutomationPrinterSelection {
    param(
        [System.Windows.Automation.AutomationElement]$Window,
        [string]$ExpectedPrinter
    )

    $comboCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::ComboBox
    )
    foreach ($combo in $Window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $comboCondition
        )) {
        foreach ($text in Get-AutomationText -Element $combo) {
            if (Test-PrinterNameMatch -Actual $text -Expected $ExpectedPrinter) {
                return $true
            }
        }

        $expandPattern = $null
        $expanded = $false
        if ($combo.TryGetCurrentPattern(
                [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
                [ref]$expandPattern
            )) {
            try {
                ([System.Windows.Automation.ExpandCollapsePattern]$expandPattern).Expand()
                $expanded = $true
                Start-Sleep -Milliseconds 150
            }
            catch {
                $expanded = $false
            }
        }

        $selected = $false
        foreach ($element in $Window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )) {
            $matches = $false
            foreach ($text in Get-AutomationText -Element $element) {
                if (Test-PrinterNameMatch -Actual $text -Expected $ExpectedPrinter) {
                    $matches = $true
                    break
                }
            }
            if (-not $matches) { continue }

            $selectionItem = $null
            if ($element.TryGetCurrentPattern(
                    [System.Windows.Automation.SelectionItemPattern]::Pattern,
                    [ref]$selectionItem
                )) {
                ([System.Windows.Automation.SelectionItemPattern]$selectionItem).Select()
                $selected = $true
                break
            }

            $invoke = $null
            if ($element.TryGetCurrentPattern(
                    [System.Windows.Automation.InvokePattern]::Pattern,
                    [ref]$invoke
                )) {
                ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
                $selected = $true
                break
            }

            $legacy = $null
            if ($element.TryGetCurrentPattern(
                    [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern,
                    [ref]$legacy
                )) {
                ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).DoDefaultAction()
                $selected = $true
                break
            }
        }

        if ($expanded) {
            try {
                ([System.Windows.Automation.ExpandCollapsePattern]$expandPattern).Collapse()
            }
            catch { }
        }
        if ($selected) {
            Start-Sleep -Milliseconds 300
            return $true
        }
    }
    return $false
}

function Get-PrintDialogCandidates {
    param(
        [string]$ExpectedPrinter,
        [switch]$AllowOtherPrinter
    )

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windowCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $buttonCondition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button
        ),
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $ConfirmButtonName
        )
    )

    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($window in $root.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $windowCondition
        )) {
        if ($window.Current.Name -ne $PrintWindowTitle) { continue }

        $processName = ''
        try {
            $processName = (Get-Process -Id $window.Current.ProcessId -ErrorAction Stop).ProcessName
        }
        catch {
            continue
        }
        if ($processName -ne 'chrome' -and $processName -notlike 'OZ*') { continue }

        $texts = [System.Collections.Generic.List[string]]::new()
        foreach ($element in $window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )) {
            foreach ($text in Get-AutomationText -Element $element) {
                $texts.Add($text)
            }
        }
        $printerMatches = @($texts | Where-Object {
                Test-PrinterNameMatch -Actual $_ -Expected $ExpectedPrinter
            } | Select-Object -Unique)
        if (-not $AllowOtherPrinter -and $printerMatches.Count -ne 1) { continue }

        $buttons = @($window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $buttonCondition
            ))
        if ($buttons.Count -ne 1) { continue }

        $matches.Add([pscustomobject]@{
                Window       = $window
                ConfirmButton = $buttons[0]
                ProcessName  = $processName
                ProcessId    = $window.Current.ProcessId
                PrinterName  = if ($printerMatches.Count -eq 1) { $printerMatches[0] } else { $null }
                ButtonEnabled = $buttons[0].Current.IsEnabled
                Source        = 'automation'
            })
    }
    return @($matches)
}

function Test-NativeDescendantOrSelf {
    param(
        [long]$Handle,
        [long]$RootHandle,
        [hashtable]$ByHandle
    )

    $current = $Handle
    for ($depth = 0; $depth -lt 64 -and $current -ne 0; $depth += 1) {
        if ($current -eq $RootHandle) { return $true }
        $node = $ByHandle[$current]
        if (-not $node) { return $false }
        $current = [long]$node.Parent
    }
    return $false
}

function Get-NativePrintDialogCandidates {
    param(
        [string]$ExpectedPrinter,
        [switch]$AllowOtherPrinter
    )

    $nodes = @([NativeWindowTree]::Enumerate())
    $byHandle = @{}
    foreach ($node in $nodes) { $byHandle[[long]$node.Handle] = $node }

    $processes = @{}
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        $processes[[uint32]$process.Id] = $process.ProcessName
    }
    $defaultPrinter = [NativeWindowTree]::ReadDefaultPrinter()
    $defaultPrinterMatches = Test-PrinterNameMatch `
        -Actual $defaultPrinter `
        -Expected $ExpectedPrinter

    $roots = @($nodes | Where-Object {
            $_.Visible -and
            $_.Text -eq $PrintWindowTitle -and
            ($processes[[uint32]$_.ProcessId] -eq 'chrome' -or $processes[[uint32]$_.ProcessId] -like 'OZ*')
        })
    if ($roots.Count -eq 0) {
        $roots = @($nodes | Where-Object {
                $_.Visible -and
                $_.ClassName -eq '#32770' -and
                ($processes[[uint32]$_.ProcessId] -eq 'chrome' -or $processes[[uint32]$_.ProcessId] -like 'OZ*')
            })
    }
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($root in $roots) {
        $subtree = @($nodes | Where-Object {
                Test-NativeDescendantOrSelf -Handle ([long]$_.Handle) -RootHandle ([long]$root.Handle) -ByHandle $byHandle
            })
        $buttons = @($subtree | Where-Object {
                $_.ClassName -eq 'Button' -and $_.Text -eq $ConfirmButtonName -and $_.Visible
            })
        $comboBoxes = @($subtree | Where-Object { $_.ClassName -eq 'ComboBox' })
        $printerTexts = @($subtree | Where-Object {
                -not [string]::IsNullOrWhiteSpace($_.Text) -and
                (Test-PrinterNameMatch -Actual $_.Text -Expected $ExpectedPrinter)
            } | Select-Object -ExpandProperty Text -Unique)
        $selectedPrinters = @($comboBoxes | ForEach-Object {
                [NativeWindowTree]::ReadSelectedComboItem([long]$_.Handle)
            } | Where-Object {
                -not [string]::IsNullOrWhiteSpace($_) -and
                (Test-PrinterNameMatch -Actual $_ -Expected $ExpectedPrinter)
            } | Select-Object -Unique)
        $printers = @($printerTexts + $selectedPrinters | Select-Object -Unique)
        if ($buttons.Count -ne 1) { continue }
        if ($comboBoxes.Count -lt 1) { continue }
        if (-not $AllowOtherPrinter -and $printers.Count -ne 1 -and -not $defaultPrinterMatches) {
            continue
        }

        $matches.Add([pscustomobject]@{
                Window        = $root
                ConfirmButton = $buttons[0]
                ProcessName   = $processes[[uint32]$root.ProcessId]
                ProcessId     = $root.ProcessId
                PrinterName   = if ($printers.Count -eq 1) {
                    $printers[0]
                } elseif ($defaultPrinterMatches) {
                    $defaultPrinter
                } else { $null }
                ButtonEnabled = $buttons[0].Enabled
                Source        = 'native'
            })
    }
    return @($matches)
}

function Get-PrintDialogDiagnosticSummary {
    $nodes = @([NativeWindowTree]::Enumerate())
    $processes = @{}
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        $processes[[uint32]$process.Id] = $process.ProcessName
    }

    $roots = @($nodes | Where-Object {
            $_.Visible -and
            (
                $_.Text -eq $PrintWindowTitle -or
                ($_.ClassName -eq '#32770' -and $processes[[uint32]$_.ProcessId] -like 'OZ*') -or
                ($_.Parent -eq 0 -and $processes[[uint32]$_.ProcessId] -eq 'chrome')
            )
        } | Select-Object -First 12)
    if ($roots.Count -eq 0) { return 'relevant visible root windows: none' }

    $summaries = @($roots | ForEach-Object {
            $processName = $processes[[uint32]$_.ProcessId]
            if ([string]::IsNullOrWhiteSpace($processName)) { $processName = 'unknown' }
            $title = if ([string]::IsNullOrWhiteSpace($_.Text)) { '<empty>' } else { $_.Text }
            "pid=$($_.ProcessId),process=$processName,parent=$($_.Parent),class=$($_.ClassName),title=$title"
        })
    return 'visible roots: ' + ($summaries -join ' | ')
}

function Set-NativePrinterSelection {
    param(
        [long]$WindowHandle,
        [string]$ExpectedPrinter
    )

    if ($WindowHandle -eq 0) { return $false }
    $nodes = @([NativeWindowTree]::Enumerate())
    $byHandle = @{}
    foreach ($node in $nodes) { $byHandle[[long]$node.Handle] = $node }
    $comboBoxes = @($nodes | Where-Object {
            $_.ClassName -eq 'ComboBox' -and
            (Test-NativeDescendantOrSelf `
                -Handle ([long]$_.Handle) `
                -RootHandle $WindowHandle `
                -ByHandle $byHandle)
        })
    foreach ($comboBox in $comboBoxes) {
        if ([NativeWindowTree]::SelectComboItem([long]$comboBox.Handle, $ExpectedPrinter)) {
            Start-Sleep -Milliseconds 300
            return $true
        }
    }
    return $false
}

function Set-PrintDialogPrinter {
    param(
        [object]$Candidate,
        [string]$ExpectedPrinter
    )

    $windowHandle = if ($Candidate.Source -eq 'native') {
        [long]$Candidate.Window.Handle
    }
    else {
        [long]$Candidate.Window.Current.NativeWindowHandle
    }
    if (Set-NativePrinterSelection -WindowHandle $windowHandle -ExpectedPrinter $ExpectedPrinter) {
        return $true
    }
    if ($Candidate.Source -eq 'automation') {
        return Set-AutomationPrinterSelection `
            -Window $Candidate.Window `
            -ExpectedPrinter $ExpectedPrinter
    }
    return $false
}

function Write-Result {
    param(
        [bool]$Success,
        [string]$Status,
        [string]$Message,
        [object]$Candidate = $null,
        [string]$PreviousPrinterName,
        [string]$DefaultPrinterName
    )

    [pscustomobject]@{
        success       = $Success
        status        = $Status
        message       = $Message
        expectedCount = $ExpectedCount
        printerName   = if ($Candidate -and -not [string]::IsNullOrWhiteSpace($Candidate.PrinterName)) {
            $Candidate.PrinterName
        }
        else {
            $PrinterName
        }
        previousPrinterName = if ([string]::IsNullOrWhiteSpace($PreviousPrinterName)) {
            $null
        }
        else {
            $PreviousPrinterName
        }
        defaultPrinterName = if ([string]::IsNullOrWhiteSpace($DefaultPrinterName)) {
            $null
        }
        else {
            $DefaultPrinterName
        }
        processName   = if ($Candidate) { $Candidate.ProcessName } else { $null }
        processId     = if ($Candidate) { $Candidate.ProcessId } else { $null }
    } | ConvertTo-Json -Compress
}

if ($Mode -eq 'PrepareDefault') {
    $previousPrinter = [NativeWindowTree]::ReadDefaultPrinter()
    if ([string]::IsNullOrWhiteSpace($previousPrinter)) {
        Write-Result -Success $false -Status 'blocked' -Message 'The current Windows default printer could not be read.'
        exit 8
    }

    if (-not (Test-PrinterNameMatch -Actual $previousPrinter -Expected $PrinterName)) {
        if (-not [NativeWindowTree]::ChangeDefaultPrinter($PrinterName)) {
            Write-Result -Success $false -Status 'blocked' -Message (
                "The fixed Logen printer could not be set as the Windows default: $PrinterName"
            ) -PreviousPrinterName $previousPrinter -DefaultPrinterName $previousPrinter
            exit 9
        }
        Start-Sleep -Milliseconds 500
    }

    $preparedPrinter = [NativeWindowTree]::ReadDefaultPrinter()
    if (-not (Test-PrinterNameMatch -Actual $preparedPrinter -Expected $PrinterName)) {
        Write-Result -Success $false -Status 'blocked' -Message (
            "Windows did not retain the fixed Logen default printer: $PrinterName"
        ) -PreviousPrinterName $previousPrinter -DefaultPrinterName $preparedPrinter
        exit 10
    }

    Write-Result -Success $true -Status 'ready' -Message (
        "Temporarily set the Windows default printer for $ExpectedCount waybill(s): $PrinterName"
    ) -PreviousPrinterName $previousPrinter -DefaultPrinterName $preparedPrinter
    exit 0
}

if ($Mode -eq 'RestoreDefault') {
    if ([string]::IsNullOrWhiteSpace($RestorePrinterName)) {
        Write-Result -Success $false -Status 'blocked' -Message 'The previous Windows default printer name is missing.'
        exit 11
    }
    if (-not [NativeWindowTree]::ChangeDefaultPrinter($RestorePrinterName)) {
        Write-Result -Success $false -Status 'blocked' -Message (
            "The previous Windows default printer could not be restored: $RestorePrinterName"
        ) -DefaultPrinterName ([NativeWindowTree]::ReadDefaultPrinter())
        exit 12
    }
    Start-Sleep -Milliseconds 500
    $restoredPrinter = [NativeWindowTree]::ReadDefaultPrinter()
    if (-not (Test-PrinterNameMatch -Actual $restoredPrinter -Expected $RestorePrinterName)) {
        Write-Result -Success $false -Status 'blocked' -Message (
            "Windows did not retain the restored default printer: $RestorePrinterName"
        ) -DefaultPrinterName $restoredPrinter
        exit 13
    }

    Write-Result -Success $true -Status 'ready' -Message (
        "Restored the previous Windows default printer: $RestorePrinterName"
    ) -DefaultPrinterName $restoredPrinter
    exit 0
}

if ($Mode -eq 'Inspect') {
    $inspectProcesses = @{}
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        if ($process.ProcessName -like 'OZ*' -or (
                $process.ProcessName -eq 'chrome' -and
                $process.MainWindowTitle -like 'iLogen*'
            )) {
            $inspectProcesses[[uint32]$process.Id] = $process.ProcessName
        }
    }
    $inspectRows = @([NativeWindowTree]::Enumerate() | Where-Object {
            $inspectProcesses.ContainsKey([uint32]$_.ProcessId) -and
            ($_.Visible -or -not [string]::IsNullOrWhiteSpace($_.Text))
        } | ForEach-Object {
            [pscustomobject]@{
                handle      = $_.Handle
                parent      = $_.Parent
                text        = $_.Text
                className   = $_.ClassName
                processId   = $_.ProcessId
                processName = $inspectProcesses[[uint32]$_.ProcessId]
                visible     = $_.Visible
                enabled     = $_.Enabled
                selectedValue = if ($_.ClassName -eq 'ComboBox') {
                    [NativeWindowTree]::ReadSelectedComboItem([long]$_.Handle)
                } else { $null }
                comboItems = if ($_.ClassName -eq 'ComboBox') {
                    @([NativeWindowTree]::ReadComboItems([long]$_.Handle))
                } else { @() }
            }
        })
    $automationRows = @()
    foreach ($match in @(Get-PrintDialogCandidates -ExpectedPrinter $PrinterName)) {
        $button = $match.ConfirmButton
        $point = $null
        try { $point = $button.GetClickablePoint() } catch { $point = $null }
        $automationRows += [pscustomobject]@{
            windowName       = $match.Window.Current.Name
            windowHandle     = $match.Window.Current.NativeWindowHandle
            buttonName       = $button.Current.Name
            buttonHandle     = $button.Current.NativeWindowHandle
            automationId     = $button.Current.AutomationId
            className        = $button.Current.ClassName
            controlType      = $button.Current.ControlType.ProgrammaticName
            isEnabled        = $button.Current.IsEnabled
            isKeyboardFocusable = $button.Current.IsKeyboardFocusable
            hasKeyboardFocus = $button.Current.HasKeyboardFocus
            boundingRectangle = [pscustomobject]@{
                x = $button.Current.BoundingRectangle.X
                y = $button.Current.BoundingRectangle.Y
                width = $button.Current.BoundingRectangle.Width
                height = $button.Current.BoundingRectangle.Height
            }
            clickablePoint = if ($point) {
                [pscustomobject]@{ x = $point.X; y = $point.Y }
            } else { $null }
            patterns = @($button.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
        }
    }
    [pscustomobject]@{
        automationCandidates = $automationRows
        windows = $inspectRows
    } | ConvertTo-Json -Depth 7 -Compress
    exit 0
}

$allowOtherPrinter = $Mode -eq 'Configure'
$candidates = @(
    Get-NativePrintDialogCandidates `
        -ExpectedPrinter $PrinterName `
        -AllowOtherPrinter:$allowOtherPrinter
)
if ($candidates.Count -eq 0) {
    $candidates = @(
        Get-PrintDialogCandidates `
            -ExpectedPrinter $PrinterName `
            -AllowOtherPrinter:$allowOtherPrinter
    )
}
if ($candidates.Count -ne 1) {
    $diagnostics = Get-PrintDialogDiagnosticSummary
    Write-Result -Success $false -Status 'blocked' -Message (
        "Expected exactly one Logen print dialog; found $($candidates.Count). Diagnostics: $diagnostics"
    )
    exit 2
}

$candidate = $candidates[0]

if ($Mode -eq 'Configure') {
    if (-not (Set-PrintDialogPrinter -Candidate $candidate -ExpectedPrinter $PrinterName)) {
        Write-Result -Success $false -Status 'blocked' -Message (
            "The fixed Logen printer could not be selected in the Windows print dialog: $PrinterName"
        ) -Candidate $candidate
        exit 6
    }

    $configured = @(Get-NativePrintDialogCandidates -ExpectedPrinter $PrinterName)
    if ($configured.Count -eq 0) {
        $configured = @(Get-PrintDialogCandidates -ExpectedPrinter $PrinterName)
    }
    if ($configured.Count -ne 1) {
        Write-Result -Success $false -Status 'blocked' -Message (
            "The Windows print dialog did not retain the fixed Logen printer selection: $PrinterName"
        ) -Candidate $candidate
        exit 7
    }

    Write-Result -Success $true -Status 'ready' -Message (
        "Selected the fixed Logen printer for $ExpectedCount waybill(s): $PrinterName"
    ) -Candidate $configured[0]
    exit 0
}

if (-not $candidate.ButtonEnabled) {
    Write-Result -Success $false -Status 'blocked' -Message 'The Logen print confirmation button is disabled.' -Candidate $candidate
    exit 3
}

if ($Mode -eq 'Probe') {
    Write-Result -Success $true -Status 'ready' -Message "The Logen print dialog is ready for $ExpectedCount waybill(s)." -Candidate $candidate
    exit 0
}

if ($candidate.Source -eq 'native') {
    if (-not [NativeWindowTree]::Click([long]$candidate.ConfirmButton.Handle)) {
        Write-Result -Success $false -Status 'blocked' -Message 'The native Logen print confirmation button could not be invoked.' -Candidate $candidate
        exit 4
    }
}
else {
    $clicked = $false
    $windowHandle = [long]$candidate.Window.Current.NativeWindowHandle
    $buttonHandle = [long]$candidate.ConfirmButton.Current.NativeWindowHandle
    if ($windowHandle -ne 0 -and $buttonHandle -ne 0) {
        # Use the native button rectangle under a per-monitor DPI-aware context
        # and send exactly one physical mouse click.
        $clicked = [NativeWindowTree]::ClickButtonOnScreen($windowHandle, $buttonHandle, 1)
    }

    if (-not $clicked) {
        Write-Result -Success $false -Status 'blocked' -Message 'The validated Logen print confirmation button could not be invoked.' -Candidate $candidate
        exit 4
    }
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-PrintDialogCandidates -ExpectedPrinter $PrinterName)
    if ($remaining.Count -eq 0) {
        $remaining = @(Get-NativePrintDialogCandidates -ExpectedPrinter $PrinterName)
    }
    if ($remaining.Count -eq 0) {
        Write-Result -Success $true -Status 'submitted' -Message "Submitted $ExpectedCount Logen waybill(s) to the Windows printer." -Candidate $candidate
        exit 0
    }
} while ([DateTime]::UtcNow -lt $deadline)

Write-Result -Success $false -Status 'unknown' -Message 'The confirmation button was invoked, but the print dialog did not close. Do not retry automatically.' -Candidate $candidate
exit 5
