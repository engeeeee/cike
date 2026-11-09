using System;
using System.IO;
using System.Xml;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ComponentModel;
using System.Diagnostics.Eventing.Reader;
using System.Drawing;
using System.Threading;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using System.Diagnostics;
using System.Management;

// Read-only image mapping, ACL/mandatory-label inspection and disposable,
// network-blocked render probes. No DLL entry point is called by ImageAccess.
public static partial class CikeCoreReport {
    [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disabledCount, IntPtr disabled, uint privilegesCount, IntPtr privileges, uint restrictedCount, SidAttributes[] restricted, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int information, IntPtr buffer, uint length, out uint needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int information, IntPtr value, uint length);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileMappingW(IntPtr file, IntPtr attributes, uint protection, uint high, uint low, string name);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string name, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint QueryDosDeviceW(string device, StringBuilder target, int size);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int information, IntPtr buffer, uint size, out uint needed);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessMitigationPolicy(IntPtr process, int policy, out uint flags, UIntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);

    static string NativeRole(IntPtr process) {
        IntPtr buffer=IntPtr.Zero;
        try {
            uint size; NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out size);
            if (size<16 || size>131072) return null;
            uint capacity=size; buffer=Marshal.AllocHGlobal((int)capacity);
            if (NtQueryInformationProcess(process, 60, buffer, size, out size) != 0) return null;
            int length=(ushort)Marshal.ReadInt16(buffer); IntPtr data=Marshal.ReadIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4);
            long offset=data.ToInt64()-buffer.ToInt64(); if (offset<0 || offset+length>capacity || length%2 != 0) return null;
            string command=Marshal.PtrToStringUni(data, length/2); // Never exported or written to disk.
            Match match=Regex.Match(command, @"(?:^|\s)(gpu|tab|rdd|socket|utility|gmplugin|vr|forkserver)(?:\s|$)", RegexOptions.IgnoreCase);
            return match.Success ? match.Groups[1].Value.ToLowerInvariant() : command.IndexOf("-contentproc", StringComparison.OrdinalIgnoreCase)>=0 ? "content-unknown" : "browser";
        } catch { return null; }
        finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); }
    }
    static object ProcessMitigations(uint id) {
        var result=Map(); IntPtr handle=OpenProcess(0x1000, false, id);
        if (handle == IntPtr.Zero) { result["status"]="unavailable"; return result; }
        try {
            foreach (var entry in new Dictionary<string, int> { {"ASLR",1}, {"dynamicCode",2}, {"systemCallDisable",4}, {"extensionPoints",6}, {"signature",8}, {"imageLoad",10} }) {
                uint flags; if (GetProcessMitigationPolicy(handle, entry.Value, out flags, new UIntPtr(4))) result[entry.Key]="0x" + flags.ToString("X8");
            }
        } finally { CloseHandle(handle); }
        return result;
    }
    static object[] ExternalModules(uint id, string root) {
        var result=new List<object>();
        try {
            using (var process=Process.GetProcessById((int)id)) foreach (ProcessModule module in process.Modules) {
                string file=module.FileName; if (file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                FileVersionInfo version=FileVersionInfo.GetVersionInfo(file);
                if ((version.CompanyName ?? "").StartsWith("Microsoft", StringComparison.OrdinalIgnoreCase)) continue;
                var row=Map(); row["name"]=Path.GetFileName(file); row["company"]=Short(version.CompanyName); row["version"]=Short(version.FileVersion);
                // Version resources identify a lead, not proof of trust or blame.
                result.Add(row); if (result.Count>=48) break;
            }
        } catch { /* Some restricted or short-lived children cannot be inspected. */ }
        return result.ToArray();
    }
    static object LaunchPolicies(string executable) {
        var report=Map(); var overrides=new List<object>();
        foreach (var hive in new Dictionary<string, RegistryKey> { {"machine", Registry.LocalMachine}, {"user", Registry.CurrentUser} }) {
            try { using (var key=hive.Value.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\camoufox.exe")) {
                if (key == null) continue;
                var selected=new List<RegistryKey>(); selected.Add(key);
                try {
                    foreach (string name in key.GetSubKeyNames()) { var child=key.OpenSubKey(name); if (child == null) continue; if (String.Equals(Text(child.GetValue("FilterFullPath")), executable, StringComparison.OrdinalIgnoreCase)) selected.Add(child); else child.Dispose(); }
                    foreach (var item in selected) {
                        var row=Map(); row["scope"]=hive.Key; row["pathSpecific"]=item != key;
                        row["debuggerConfigured"]=!String.IsNullOrEmpty(Text(item.GetValue("Debugger")));
                        foreach (string value in new string[] { "MitigationOptions", "MitigationAuditOptions" }) { byte[] bytes=item.GetValue(value) as byte[]; if (bytes != null) row[value]=BitConverter.ToString(bytes); }
                        object flag=item.GetValue("GlobalFlag"); if (flag is int) row["globalFlag"]="0x" + ((int)flag).ToString("X8"); overrides.Add(row);
                    }
                } finally { foreach (var item in selected) if (item != key) item.Dispose(); }
            } } catch (Exception e) { Error("launch-policy", e); }
        }
        report["imageExecutionOverrides"]=overrides.ToArray();
        try { using (var key=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows")) {
            if (key != null) { var row=Map(); row["configured"]=!String.IsNullOrWhiteSpace(Text(key.GetValue("AppInit_DLLs")));
                row["loadEnabled"]=Convert.ToInt32(key.GetValue("LoadAppInit_DLLs",0)); row["requireSigned"]=Convert.ToInt32(key.GetValue("RequireSignedAppInit_DLLs",0)); report["appInit"]=row; }
        } } catch (Exception e) { Error("appinit-policy",e); }
        var products=new List<object>();
        try { using (var search=new ManagementObjectSearcher("root\\SecurityCenter2", "SELECT displayName,productState FROM AntiVirusProduct", new EnumerationOptions { Timeout=TimeSpan.FromSeconds(5) })) using (var values=search.Get()) {
            foreach (ManagementObject value in values) { var row=Map(); row["name"]=Short(value["displayName"]); row["state"]=value["productState"]; products.Add(row); }
        } } catch { /* Windows Server has no SecurityCenter2 provider. */ }
        report["registeredAntivirus"]=products.ToArray(); return report;
    }

    sealed class LowReadToken : IDisposable {
        public IntPtr Handle;
        public LowReadToken() {
            IntPtr original = IntPtr.Zero, restricted = IntPtr.Zero, groups = IntPtr.Zero, sid = IntPtr.Zero, user = IntPtr.Zero;
            try {
                if (!OpenProcessToken(GetCurrentProcess(), 0xA, out original)) throw new Win32Exception();
                uint size; GetTokenInformation(original, 2, IntPtr.Zero, 0, out size);
                groups = Marshal.AllocHGlobal((int)size);
                if (!GetTokenInformation(original, 2, groups, size, out size)) throw new Win32Exception();
                var restrict = new List<SidAttributes>(); int count = Marshal.ReadInt32(groups);
                for (int i=0; i<count; i++) {
                    var entry = (SidAttributes)Marshal.PtrToStructure(IntPtr.Add(groups, (IntPtr.Size == 8 ? 8 : 4) + i * Marshal.SizeOf(typeof(SidAttributes))), typeof(SidAttributes));
                    if ((entry.Attributes & 4) != 0 && (entry.Attributes & 0x30) == 0) restrict.Add(new SidAttributes { Sid=entry.Sid });
                }
                byte[] identity = new byte[WindowsIdentity.GetCurrent().User.BinaryLength]; WindowsIdentity.GetCurrent().User.GetBinaryForm(identity, 0);
                user = Marshal.AllocHGlobal(identity.Length); Marshal.Copy(identity, 0, user, identity.Length); restrict.Add(new SidAttributes { Sid=user });
                // Same-access restricting SIDs and a low integrity label model
                // Firefox's initial loader token, not its later broker policy.
                if (!CreateRestrictedToken(original, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrict.Count, restrict.ToArray(), out restricted)) throw new Win32Exception();
                if (!DuplicateTokenEx(restricted, 0xF01FF, IntPtr.Zero, 2, 2, out Handle)) throw new Win32Exception();
                var low = new SecurityIdentifier("S-1-16-4096"); byte[] bytes = new byte[low.BinaryLength]; low.GetBinaryForm(bytes, 0);
                int labelSize=Marshal.SizeOf(typeof(SidAttributes));
                sid = Marshal.AllocHGlobal(labelSize + bytes.Length); Marshal.Copy(bytes, 0, IntPtr.Add(sid,labelSize), bytes.Length);
                var label = new SidAttributes { Sid=IntPtr.Add(sid,labelSize), Attributes=0x20 }; Marshal.StructureToPtr(label,sid,false);
                if (!SetTokenInformation(Handle, 25, sid, (uint)(labelSize + bytes.Length))) throw new Win32Exception();
            } catch { Dispose(); throw; }
            finally { if (original != IntPtr.Zero) CloseHandle(original); if (restricted != IntPtr.Zero) CloseHandle(restricted); if (groups != IntPtr.Zero) Marshal.FreeHGlobal(groups); if (user != IntPtr.Zero) Marshal.FreeHGlobal(user); if (sid != IntPtr.Zero) Marshal.FreeHGlobal(sid); }
        }
        public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle=IntPtr.Zero; } }
    }
    static Dictionary<string, object> ImageAccess(string file, IntPtr token) {
        var row = Map(); IntPtr image = IntPtr.Zero, handle = new IntPtr(-1); bool impersonating = false;
        try {
            if (token != IntPtr.Zero) { if (!ImpersonateLoggedOnUser(token)) throw new Win32Exception(); impersonating=true; }
            handle = CreateFileW(file, 0xA0000000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ | GENERIC_EXECUTE
            if (handle == new IntPtr(-1)) { int error=Marshal.GetLastWin32Error(); row["status"]=error==5 ? "open-denied" : "open-failed"; row["win32"]=error; }
            else {
                image = CreateFileMappingW(handle, IntPtr.Zero, 0x01000002, 0, 0, null); // SEC_IMAGE, never executed
                if (image == IntPtr.Zero) { row["status"]="image-rejected"; row["win32"]=Marshal.GetLastWin32Error(); }
                else row["status"]="mapped";
            }
        } finally {
            if (image != IntPtr.Zero) CloseHandle(image); if (handle != new IntPtr(-1)) CloseHandle(handle);
            if (impersonating && !RevertToSelf()) Environment.FailFast("Cannot revert diagnostic impersonation");
        }
        return row;
    }
    static string Principal(SecurityIdentifier identity) {
        if (identity.Equals(WindowsIdentity.GetCurrent().User)) return "current-user";
        var known = new Dictionary<string, string> { {"S-1-5-18", "SYSTEM"}, {"S-1-5-32-544", "Administrators"}, {"S-1-5-32-545", "Users"}, {"S-1-1-0", "Everyone"}, {"S-1-5-11", "Authenticated Users"}, {"S-1-15-2-1", "All Application Packages"}, {"S-1-15-2-2", "All Restricted Application Packages"} };
        string name; return known.TryGetValue(identity.Value, out name) ? name : "other-principal";
    }
    static object AccessDescriptor(string file, bool directory) {
        var row = Map();
        try {
            FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(file, AccessControlSections.Access | AccessControlSections.Owner) : File.GetAccessControl(file, AccessControlSections.Access | AccessControlSections.Owner);
            row["owner"]=Principal((SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier))); row["inheritanceBlocked"]=acl.AreAccessRulesProtected;
            var rules = new List<object>();
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
                var item=Map(); item["principal"]=Principal((SecurityIdentifier)rule.IdentityReference); item["type"]=rule.AccessControlType.ToString();
                item["rights"]="0x" + ((uint)rule.FileSystemRights).ToString("X8"); item["inherited"]=rule.IsInherited; rules.Add(item);
                item["inheritance"]=rule.InheritanceFlags.ToString(); item["propagation"]=rule.PropagationFlags.ToString();
            }
            row["rules"]=rules.ToArray();
        } catch (Exception e) { row["aclError"]=e.GetType().Name; }
        IntPtr descriptor=IntPtr.Zero, sacl, text=IntPtr.Zero;
        try {
            uint code=GetNamedSecurityInfoW(file, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sacl, out descriptor);
            if (code != 0) row["labelError"]=code;
            // GetNamedSecurityInfo returned only the label portion of the
            // SACL. Serialize that SACL explicitly, including on Windows 10.
            else { uint size; if (ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 8, out text, out size)) row["mandatoryLabel"]=Marshal.PtrToStringUni(text); }
        } finally { if (text != IntPtr.Zero) LocalFree(text); if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        return row;
    }
    static object AccessReport(string executable, Dictionary<string, object> reference) {
        var report=Map(); if (!File.Exists(executable)) { report["status"]="no-kernel"; return report; }
        var images=new List<object>(); string root=Path.GetDirectoryName(executable); LowReadToken low=null;
        try { var drive=new DriveInfo(Path.GetPathRoot(executable)); report["fileSystem"]=drive.DriveFormat; report["driveType"]=drive.DriveType.ToString(); } catch (Exception e) { report["volumeError"]=e.GetType().Name; }
        try {
            try { low=new LowReadToken(); report["lowToken"]=true; } catch (Exception e) { report["lowToken"]=false; Error("low-read-token", e); }
            foreach (Dictionary<string, object> file in (IEnumerable)reference["files"]) {
                string name=Text(file["name"]); if (!Regex.IsMatch(name, @"\.(exe|dll)$", RegexOptions.IgnoreCase)) continue;
                string full=Path.GetFullPath(Path.Combine(root, name.Replace('/', Path.DirectorySeparatorChar)));
                if (!full.StartsWith(Path.GetFullPath(root).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
                var row=Map(); row["name"]=name; row["location"]="kernel"; row["currentToken"]=ImageAccess(full, IntPtr.Zero);
                if (File.Exists(full)) row["attributes"]=(uint)File.GetAttributes(full);
                if (low != null) row["lowToken"]=ImageAccess(full, low.Handle); row["permissions"]=AccessDescriptor(full, false); images.Add(row);
            }
            string system=Environment.GetFolderPath(Environment.SpecialFolder.System);
            foreach (string name in new string[] { "ntdll.dll", "kernel32.dll", "KernelBase.dll", "user32.dll", "gdi32.dll", "win32u.dll", "ucrtbase.dll", "vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "concrt140.dll", "d3d11.dll", "dxgi.dll" }) {
                string full=Path.Combine(system, name); var row=Map(); row["name"]=name; row["location"]="system";
                if (!File.Exists(full)) row["status"]="not-installed";
                else { row["currentToken"]=ImageAccess(full, IntPtr.Zero); if (low != null) row["lowToken"]=ImageAccess(full, low.Handle); row["permissions"]=AccessDescriptor(full, false); }
                images.Add(row);
            }
        } finally { if (low != null) low.Dispose(); }
        report["images"]=images.ToArray(); var directories=new List<object>(); var dir=new DirectoryInfo(root);
        for (int depth=0; dir != null && depth<8; depth++, dir=dir.Parent) { var row=Map(); row["depth"]=depth; row["permissions"]=AccessDescriptor(dir.FullName, true); directories.Add(row); }
        report["directories"]=directories.ToArray(); return report;
    }
    static Dictionary<string, object> SecurityRecord(string xml, string executable) {
        var document=new XmlDocument(); document.XmlResolver=null;
        var settings=new XmlReaderSettings { DtdProcessing=DtdProcessing.Prohibit, XmlResolver=null };
        using (var reader=XmlReader.Create(new StringReader(xml), settings)) document.Load(reader);
        string root=Path.GetFullPath(Path.GetDirectoryName(executable)).TrimEnd('\\') + "\\"; bool match=false;
        var prefixes=new List<string> { root, @"\??\" + root, @"\\?\" + root };
        var device=new StringBuilder(32768); if (root.Length>=3 && root[1]==':' && QueryDosDeviceW(root.Substring(0,2),device,device.Capacity)>0) prefixes.Add(device.ToString() + root.Substring(2));
        var files=new HashSet<string>(StringComparer.OrdinalIgnoreCase); var codes=new List<string>();
        foreach (XmlNode node in document.SelectNodes("//*[local-name()='EventData']/*[local-name()='Data'] | //*[local-name()='UserData']//*[not(*)]")) {
            string value=node.InnerText.Trim().Trim('"');
            // Match exact kernel paths, never merely the executable's basename.
            foreach (string prefix in prefixes) if (value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { match=true; files.Add(Path.GetFileName(value)); break; }
            var name=node.Attributes["Name"]; string field=name == null ? node.LocalName : name.Value;
            if (Regex.IsMatch(field, "^(FileName|FilePath|ImageName|ImageFileName|ProcessName|ProcessPath)$", RegexOptions.IgnoreCase) && Regex.IsMatch(value, @"^(?:[a-zA-Z]:\\|\\Device\\).+\.(dll|exe)$", RegexOptions.IgnoreCase)) files.Add(Path.GetFileName(value));
            if (Regex.IsMatch(field, "^(Status|ErrorCode|Error|StatusCode|VerificationError|RequestedSigningLevel|ValidatedSigningLevel)$", RegexOptions.IgnoreCase) && Regex.IsMatch(value, @"^(0x[0-9a-fA-F]{1,16}|[0-9]{1,10})$")) codes.Add(field + "=" + value);
        }
        if (!match) return null;
        var row=Map(); XmlNode id=document.SelectSingleNode("//*[local-name()='System']/*[local-name()='EventID']");
        XmlNode time=document.SelectSingleNode("//*[local-name()='TimeCreated']/@SystemTime"); row["eventId"]=id == null ? "" : id.InnerText;
        if (time != null) row["time"]=time.Value; row["files"]=new List<string>(files).ToArray(); row["codes"]=codes.ToArray(); return row;
    }
    static object[] SecurityRecords(string executable) {
        var results=new List<object>(); if (!File.Exists(executable)) return results.ToArray();
        foreach (string log in new string[] { "Microsoft-Windows-CodeIntegrity/Operational", "Microsoft-Windows-AppLocker/EXE and DLL", "Microsoft-Windows-Windows Defender/Operational", "Microsoft-Windows-Security-Mitigations/UserMode", "Microsoft-Windows-Security-Mitigations/KernelMode" }) {
            var channel=Map(); channel["channel"]=log; var entries=new List<object>();
            try {
                var query=new EventLogQuery(log, PathType.LogName, "*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]") { ReverseDirection=true };
                using (var reader=new EventLogReader(query)) {
                    int inspected=0; EventRecord entry;
                    while (entries.Count<12 && inspected++<512 && (entry=reader.ReadEvent()) != null) using (entry) {
                        var row=SecurityRecord(entry.ToXml(), executable); if (row != null) entries.Add(row);
                    }
                }
                channel["status"]="read";
            } catch (EventLogNotFoundException) { channel["status"]="unavailable"; }
            catch (UnauthorizedAccessException) { channel["status"]="access-denied"; }
            catch (Exception e) { channel["status"]="error"; channel["error"]=e.GetType().Name; }
            channel["records"]=entries.ToArray(); results.Add(channel);
        }
        return results.ToArray();
    }

    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public uint Size; public IntPtr Reserved, Desktop, Title; public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Id,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicJobLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits { public BasicJobLimits Basic; public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, string environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int information, ref JobLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr value, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    delegate bool WindowVisitor(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool contained);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    static string QuoteArgument(string value) { return "\"" + Regex.Replace(Regex.Replace(value, @"(\\*)""", "$1$1\\\""), @"(\\+)$", "$1$1") + "\""; }
    static object[] ProbeExits(object[] records, uint root) {
        var own=new HashSet<uint>(); own.Add(root);
        for (int pass=0; pass<8; pass++) foreach (Dictionary<string, object> row in records) if (own.Contains((uint)row["parent"])) own.Add((uint)row["pid"]);
        var result=new List<object>(); foreach (Dictionary<string, object> row in records) if (own.Contains((uint)row["pid"])) result.Add(row); return result.ToArray();
    }
    static bool VisibleProbeWindow(IntPtr job) {
        bool found=false;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window)) return true;
            uint id; GetWindowThreadProcessId(window,out id); IntPtr process=OpenProcess(0x1000,false,id);
            if (process == IntPtr.Zero) return true;
            try { bool contained; if (IsProcessInJob(process,job,out contained) && contained) found=true; } finally { CloseHandle(process); }
            return !found;
        },IntPtr.Zero);
        return found;
    }
    static object RenderProbe(string executable, bool software, bool headed=false) {
        var result=Map(); result["mode"]=(headed ? "headed-" : "") + (software ? "software" : "default");
        string root=Path.Combine(Path.GetTempPath(), "cike-offline-probe-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        IntPtr job=IntPtr.Zero; var process=new ProcessInfo(); bool assigned=false;
        try {
            string profile=Path.Combine(root, "profile"); Directory.CreateDirectory(profile); string screenshot=Path.Combine(root, "page.png");
            var prefs=new Dictionary<string, object> {
                {"network.proxy.type", 1}, {"network.proxy.http", "127.0.0.1"}, {"network.proxy.http_port", 9},
                {"network.proxy.ssl", "127.0.0.1"}, {"network.proxy.ssl_port", 9}, {"network.proxy.no_proxies_on", ""},
                {"network.proxy.failover_direct", false}, {"network.proxy.allow_hijacking_localhost", true}, {"network.proxy.share_proxy_settings", true},
                {"network.trr.mode", 5}, {"network.dns.disablePrefetch", true}, {"network.prefetch-next", false}, {"network.http.speculative-parallel-limit", 0},
                {"media.peerconnection.enabled", false}, {"browser.shell.checkDefaultBrowser", false}, {"browser.startup.page", 0},
                {"browser.startup.homepage", "about:blank"}, {"browser.newtabpage.enabled", false}, {"browser.newtabpage.activity-stream.feeds.telemetry", false},
                {"datareporting.policy.dataSubmissionEnabled", false}, {"toolkit.telemetry.enabled", false}, {"app.update.auto", false},
                {"app.normandy.enabled", false}, {"app.shield.optoutstudies.enabled", false}, {"browser.sessionstore.resume_from_crash", false}
            };
            if (software) foreach (var entry in new Dictionary<string, object> {
                {"gfx.webrender.software", true}, {"gfx.webrender.compositor", false}, {"layers.acceleration.disabled", true},
                {"layers.gpu-process.enabled", false}, {"layers.gpu-process.force-enabled", false}, {"gfx.canvas.accelerated", false},
                {"gfx.canvas.remote", false}, {"media.hardware-video-decoding.enabled", false}, {"gfx.webrender.software.d3d11", false}, {"gfx.direct2d.disabled", true}
            }) prefs[entry.Key]=entry.Value;
            var lines=new StringBuilder(); foreach (var entry in prefs) lines.AppendLine("user_pref(" + Json.Serialize(entry.Key) + "," + Json.Serialize(entry.Value) + ");");
            File.WriteAllText(Path.Combine(profile, "user.js"), lines.ToString(), new UTF8Encoding(false));
            var env=new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
                string name=(string)entry.Key;
                if (name.StartsWith("CAMOU_CONFIG", StringComparison.OrdinalIgnoreCase) || name.StartsWith("CAMOU_PREFS", StringComparison.OrdinalIgnoreCase) || name.StartsWith("MOZ_", StringComparison.OrdinalIgnoreCase) || name.Equals("__COMPAT_LAYER", StringComparison.OrdinalIgnoreCase)) continue;
                env[name]=Text(entry.Value);
            }
            // Autoconfig consumes these same preferences. No sandbox preference
            // or mitigation is lowered, and no existing profile is opened.
            env["CAMOU_CONFIG_1"]="{}";
            string serialized=Json.Serialize(prefs); for (int i=0; i<serialized.Length; i+=2047) env["CAMOU_PREFS_" + (i/2047+1)]=serialized.Substring(i, Math.Min(2047, serialized.Length-i));
            var environment=new StringBuilder(); foreach (var entry in env) environment.Append(entry.Key).Append('=').Append(entry.Value).Append('\0'); environment.Append('\0');
            string url="data:text/html,<html><body style=\"margin:0;background:rgb(18,52,86)\">CIKE offline probe</body></html>";
            string[] args=headed
                ? new string[] {executable, "-no-remote", "-wait-for-browser", "-profile", profile, "--width", "640", "--height", "480", url}
                : new string[] {executable, "-headless", "-no-remote", "-wait-for-browser", "-profile", profile, "--screenshot", screenshot, "--window-size", "128,128", url};
            var command=new List<string>(); foreach (string arg in args) command.Add(QuoteArgument(arg));
            job=CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception();
            var limits=new JobLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE, only the suspended probe and its children
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) throw new Win32Exception();
            using (var capture=new ExitCapture(executable, false)) {
                var startup=new StartupInfo(); startup.Size=(uint)Marshal.SizeOf(typeof(StartupInfo));
                if (!CreateProcessW(executable, new StringBuilder(String.Join(" ", command.ToArray())), IntPtr.Zero, IntPtr.Zero, false, 0x08000404, environment.ToString(), Path.GetDirectoryName(executable), ref startup, out process)) throw new Win32Exception();
                if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception(); assigned=true;
                if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception();
                bool timedOut=false; DateTime cleanup;
                if (headed) {
                    Thread.Sleep(12000);
                    result["visibleWindow"]=VisibleProbeWindow(job);
                    result["status"]=WaitForSingleObject(process.Process,0)==0 ? "exited-during-observation" : "observed";
                } else timedOut=WaitForSingleObject(process.Process,25000)!=0;
                cleanup=DateTime.UtcNow;
                if (timedOut) { TerminateJobObject(job, 1); WaitForSingleObject(process.Process, 2000); }
                uint code; if (WaitForSingleObject(process.Process,0)==0 && GetExitCodeProcess(process.Process,out code)) result["exitStatus"]="0x" + code.ToString("X8"); else result["processState"]="running";
                if (!headed) result["status"]=timedOut ? "timeout" : "no-render";
                if (!headed && File.Exists(screenshot)) using (var bitmap=new Bitmap(screenshot)) {
                    Color pixel=bitmap.GetPixel(bitmap.Width/2, bitmap.Height/2);
                    result["width"]=bitmap.Width; result["height"]=bitmap.Height; result["pixel"]=new int[] {pixel.R,pixel.G,pixel.B};
                    if (!timedOut && bitmap.Width==128 && bitmap.Height==128 && pixel.R==18 && pixel.G==52 && pixel.B==86) result["status"]="painted";
                }
                // Stop only this job before taking the final exit snapshot.
                result["cleanupStartedAt"]=cleanup.ToString("o");
                TerminateJobObject(job, 1); Thread.Sleep(150);
                object[] exits=ProbeExits(capture.Results(), process.Id);
                foreach (Dictionary<string,object> row in exits) if (String.CompareOrdinal(Text(row["time"]),cleanup.ToString("o"))>=0 && Text(row["exitStatus"])=="0x00000001") row["toolCleanup"]=true;
                result["nativeProcessExits"]=exits;
            }
        } catch (Exception e) { result["status"]="error"; result["error"]=e.GetType().Name; result["hresult"]="0x" + e.HResult.ToString("X8"); if (e is Win32Exception) result["win32"]=((Win32Exception)e).NativeErrorCode; }
        finally {
            if (process.Process != IntPtr.Zero) { if (!assigned) TerminateProcess(process.Process, 1); else if (job != IntPtr.Zero) TerminateJobObject(job, 1); WaitForSingleObject(process.Process, 2000); CloseHandle(process.Process); }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread); if (job != IntPtr.Zero) CloseHandle(job);
            for (int attempt=0; attempt<6; attempt++) try { Directory.Delete(root, true); break; } catch { if (attempt==5) result["temporaryCleanup"]="pending"; else Thread.Sleep(200); }
        }
        return result;
    }
    static void AccessSelfTest() {
        Console.WriteLine("Checking Windows image execute access, low token and log redaction");
        string root=Path.Combine(Path.GetTempPath(), "cike-access-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try {
            string file=Path.Combine(root, "fixture.exe"); File.Copy(typeof(CikeCoreReport).Assembly.Location, file);
            var initial=ImageAccess(file,IntPtr.Zero);
            if (Text(initial["status"]) != "mapped") throw new Exception("Image mapping fixture failed: " + Json.Serialize(initial));
            using (var low=new LowReadToken()) {
                var access=ImageAccess(file,low.Handle);
                if (Text(access["status"]) != "mapped") throw new Exception("Low-token image mapping fixture failed: " + Json.Serialize(access));
            }
            var original=File.GetAccessControl(file, AccessControlSections.Access);
            try {
                var denied=File.GetAccessControl(file, AccessControlSections.Access); denied.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.ExecuteFile, AccessControlType.Deny)); File.SetAccessControl(file, denied);
                // A matching SHA and successful ordinary read do not prove the
                // Windows loader has permission to execute/map the DLL.
                Hash(file); var observed=ImageAccess(file, IntPtr.Zero);
                if (Text(observed["status"]) != "open-denied" || Convert.ToInt32(observed["win32"]) != 5) throw new Exception("Execute-denied fixture was not detected");
            } finally {
                // File.SetAccessControl persists only sections marked modified;
                // an untouched snapshot would silently leave the deny ACE.
                var restored=new FileSecurity(); restored.SetSecurityDescriptorBinaryForm(original.GetSecurityDescriptorBinaryForm(),AccessControlSections.Access);
                File.SetAccessControl(file,restored);
            }
            var after=ImageAccess(file,IntPtr.Zero);
            if (Text(after["status"]) != "mapped") throw new Exception("ACL fixture restoration failed: " + Json.Serialize(after));
            string xml="<Event><System><EventID>3077</EventID></System><EventData><Data Name='FileName'>D:\\private\\xul.dll</Data><Data Name='Status'>0xc0000022</Data><Data Name='URL'>https://secret.invalid/</Data><Data Name='UserName'>private-person</Data></EventData></Event>";
            string result=Json.Serialize(SecurityRecord(xml, @"D:\private\camoufox.exe"));
            if (!result.Contains("xul.dll") || !result.Contains("0xc0000022") || result.Contains("private") || result.Contains("secret")) throw new Exception("Security event redaction failed");
            if (SecurityRecord(xml, @"C:\unrelated\camoufox.exe") != null) throw new Exception("Security event kernel scoping failed");
            if (QuoteArgument("C:\\path with spaces\\") != "\"C:\\path with spaces\\\\\"") throw new Exception("Windows argument quoting failed");
            string[] arguments={ @"D:\cike core\camoufox.exe", @"C:\临时目录\", "data:text/html,<body style=\"margin:0\">test</body>", "", "embedded\\\"quote" };
            var quoted=new List<string>(); foreach (string arg in arguments) quoted.Add(QuoteArgument(arg));
            int count; IntPtr argv=CommandLineToArgvW(String.Join(" ", quoted.ToArray()), out count);
            try {
                if (argv==IntPtr.Zero || count!=arguments.Length) throw new Exception("Argument round trip failed");
                for (int i=0; i<count; i++) if (Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size))!=arguments[i]) throw new Exception("Argument round trip changed a value");
            } finally { if (argv!=IntPtr.Zero) LocalFree(argv); }
        } finally { Directory.Delete(root, true); }
        Console.WriteLine("Windows loader access and security-log self-tests passed");
    }
}
