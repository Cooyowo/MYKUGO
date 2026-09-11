# Native Windows pickers for the local web UI.
#
# NOTE: this file is intentionally ASCII-only.
# Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a UTF-8 BOM,
# so non-ASCII text here would be mangled. All Chinese UI text lives in the web page.
#
# Modes:
#   -Mode folder : modern Vista+ folder picker (IFileOpenDialog + FOS_PICKFOLDERS),
#                  which has the breadcrumb/address bar the legacy
#                  FolderBrowserDialog lacks - you can paste a path there.
#   -Mode files  : modern multi-select file dialog (WinForms OpenFileDialog).
#
# Output: the picked paths, one per line, on stdout (UTF-8). Nothing when cancelled.
# Exit code: 0 = dialog shown (picked or cancelled), 1 = could not show the dialog.
#
# -CompileOnly builds the C# helper and exits, so the risky part (P/Invoke
# signatures) can be verified without showing any UI.

param(
    [ValidateSet('folder', 'files')]
    [string]$Mode = 'folder',
    [string]$Title = 'Select',
    [switch]$CompileOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class NativeFolderPicker
{
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private static readonly Guid CLSID_FileOpenDialog = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");

    // Returns the picked folder, or null when the user cancels.
    public static string PickFolder(string title)
    {
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_FileOpenDialog));
        IFileDialog dialog = (IFileDialog)instance;

        dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);

        int hr = dialog.Show(IntPtr.Zero);
        if (hr != 0) return null; // cancelled (ERROR_CANCELLED) or closed

        IShellItem item;
        dialog.GetResult(out item);
        IntPtr buffer;
        item.GetDisplayName(SIGDN_FILESYSPATH, out buffer);
        string path = Marshal.PtrToStringUni(buffer);
        Marshal.FreeCoTaskMem(buffer);
        return path;
    }
}
'@

function Show-FolderPicker {
    param([string]$DialogTitle)
    $picked = [NativeFolderPicker]::PickFolder($DialogTitle)
    if ($picked) { Write-Output $picked }
}

function Show-FilePicker {
    param([string]$DialogTitle)
    Add-Type -AssemblyName System.Windows.Forms | Out-Null

    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = $DialogTitle
    $dialog.Multiselect = $true
    $dialog.Filter = 'Kugou encrypted audio (*.kgg)|*.kgg|All files (*.*)|*.*'

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $dialog.FileNames | ForEach-Object { Write-Output $_ }
    }
}

try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null

    if ($CompileOnly) {
        Write-Output 'COMPILE_OK'
        exit 0
    }

    if ($Mode -eq 'folder') {
        Show-FolderPicker -DialogTitle $Title
    } else {
        Show-FilePicker -DialogTitle $Title
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
