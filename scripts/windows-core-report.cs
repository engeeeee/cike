using System;
using System.IO;
using System.Xml;
using System.Text;
using System.Management;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics.Eventing.Reader;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Threading;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Win32;

// Standalone .NET Framework 4 tool. Host/integrity and native access checks;
// disposable offline probes never open an existing browser profile.
public static partial class CikeCoreReport {
    static JavaScriptSerializer Json = new JavaScriptSerializer();
    static List<string> Errors = new List<string>();
    static string[] CrashFields = { "AppVersion", "ModuleVersion", "ExceptionCode", "FaultingOffset" };
    [StructLayout(LayoutKind.Sequential)] public class MemoryStatus {
        public uint Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        public uint Load;
        public ulong TotalPhysical, AvailablePhysical, CommitLimit, AvailableCommit, TotalVirtual, AvailableVirtual, Reserved;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatus value);
    [DllImport("kernel32.dll")] static extern uint GetACP();

    sealed class ExitCapture : IDisposable {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
            public uint Size, Usage, Id; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
        }
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr value, uint timeout);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
        class Tracked { public uint Id, Parent; public string Name; public IntPtr Handle; }
        readonly object Sync = new object();
        readonly HashSet<uint> Family = new HashSet<uint>();
        readonly Dictionary<uint, Tracked> Processes = new Dictionary<uint, Tracked>();
        readonly List<Dictionary<string, object>> Pending = new List<Dictionary<string, object>>();
        readonly Dictionary<uint, string> Roles = new Dictionary<uint, string>();
        readonly Dictionary<uint, object> Details = new Dictionary<uint, object>();
        readonly string Root;
        readonly Thread Poller;
        ManagementEventWatcher Watcher;
        volatile bool Stopped;
        public ExitCapture(string executable, bool useEvents = true) {
            Root = Path.GetDirectoryName(Path.GetFullPath(executable)).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            try { if (useEvents) {
                Watcher = new ManagementEventWatcher(new WqlEventQuery("SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName='camoufox.exe' OR ProcessName='plugin-container.exe'"));
                Watcher.EventArrived += delegate(object sender, EventArrivedEventArgs args) {
                    try { Add(Convert.ToUInt32(args.NewEvent["ProcessID"]), Convert.ToUInt32(args.NewEvent["ParentProcessID"]),
                        Text(args.NewEvent["ProcessName"]), Convert.ToUInt32(args.NewEvent["ExitStatus"]), "windows-event"); } catch {}
                };
                Watcher.Start();
            }
            } catch (Exception e) { Error("process-events", e); if (Watcher != null) { Watcher.Dispose(); Watcher = null; } }
            Poller = new Thread(Poll); Poller.IsBackground = true; Poller.Start();
        }
        void FindRole(uint id) {
            try { var details=Map(); details["mitigations"]=ProcessMitigations(id); details["externalModules"]=ExternalModules(id,Root); lock (Sync) Details[id]=details; } catch {}
            lock (Sync) if (Roles.ContainsKey(id)) return;
            try {
                using (var process = new ManagementObject("Win32_Process.Handle='" + id + "'")) {
                    process.Get(); string command = Text(process["CommandLine"]), role = "browser";
                    Match match = Regex.Match(command, @"(?:^|\s)(gpu|tab|rdd|socket|utility|gmplugin|vr|forkserver)(?:\s|$)", RegexOptions.IgnoreCase);
                    if (match.Success) role = match.Groups[1].Value.ToLowerInvariant();
                    else if (command.IndexOf("-contentproc", StringComparison.OrdinalIgnoreCase) >= 0) role = "content-unknown";
                    lock (Sync) Roles[id] = role;
                }
            } catch { /* The process can exit before WMI answers. Never export its command line. */ }
        }
        void Add(uint id, uint parent, string name, uint code, string source) {
            var row = Map(); row["pid"] = id; row["parent"] = parent; row["name"] = name;
            row["exitStatus"] = "0x" + code.ToString("X8"); row["source"] = source; row["time"] = DateTime.UtcNow.ToString("o");
            lock (Sync) { if (Pending.Count < 256) Pending.Add(row); }
        }
        void Poll() {
            try {
                while (!Stopped) {
                    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
                    if (snapshot != new IntPtr(-1)) try {
                        var entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                        if (Process32FirstW(snapshot, ref entry)) do {
                            if (!String.Equals(entry.Name, "camoufox.exe", StringComparison.OrdinalIgnoreCase) && !String.Equals(entry.Name, "plugin-container.exe", StringComparison.OrdinalIgnoreCase)) continue;
                            if (Processes.ContainsKey(entry.Id)) continue;
                            IntPtr handle = OpenProcess(0x101000, false, entry.Id); if (handle == IntPtr.Zero) continue;
                            bool own; lock (Sync) own = Family.Contains(entry.Parent);
                            var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
                            if (QueryFullProcessImageNameW(handle, 0, image, ref size)) own |= image.ToString().StartsWith(Root, StringComparison.OrdinalIgnoreCase);
                            if (own) {
                                lock (Sync) Family.Add(entry.Id);
                                Processes.Add(entry.Id, new Tracked { Id=entry.Id, Parent=entry.Parent, Name=entry.Name, Handle=handle });
                                string nativeRole=NativeRole(handle); if (nativeRole != null) lock (Sync) Roles[entry.Id]=nativeRole;
                                uint processId = entry.Id; ThreadPool.QueueUserWorkItem(delegate(object state) { FindRole(processId); });
                            } else CloseHandle(handle);
                        } while (Process32NextW(snapshot, ref entry));
                    } finally { CloseHandle(snapshot); }
                    var ended = new List<uint>();
                    foreach (var pair in Processes) if (WaitForSingleObject(pair.Value.Handle, 0) == 0) {
                        uint code; if (GetExitCodeProcess(pair.Value.Handle, out code)) Add(pair.Key, pair.Value.Parent, pair.Value.Name, code, "process-handle");
                        CloseHandle(pair.Value.Handle); ended.Add(pair.Key);
                    }
                    foreach (uint id in ended) Processes.Remove(id);
                    Thread.Sleep(20);
                }
            } catch (Exception e) { lock (Sync) Error("process-observer", e); }
            finally { foreach (var value in Processes.Values) CloseHandle(value.Handle); Processes.Clear(); }
        }
        public object[] Results() {
            lock (Sync) {
                // Stop events include the parent even when the child died too
                // quickly to open. Associate only this kernel's process family.
                for (int pass=0; pass<8; pass++) foreach (var row in Pending)
                    if (Family.Contains((uint)row["parent"])) Family.Add((uint)row["pid"]);
                var output = new List<object>(); var seen = new HashSet<string>();
                foreach (var row in Pending) if (Family.Contains((uint)row["pid"]) && seen.Add(row["pid"] + ":" + row["exitStatus"])) {
                    string role; if (Roles.TryGetValue((uint)row["pid"], out role)) row["role"] = role;
                    object details; if (Details.TryGetValue((uint)row["pid"], out details)) row["details"] = details; output.Add(row);
                }
                return output.ToArray();
            }
        }
        public void Dispose() {
            Stopped = true; Poller.Join(2000);
            if (Watcher != null) { try { Watcher.Stop(); } catch {} Watcher.Dispose(); }
        }
    }

    static Dictionary<string, object> Map() { return new Dictionary<string, object>(); }
    static string Text(object value) { return value == null ? "" : Convert.ToString(value); }
    static string Short(object value) { string s = Text(value); return s.Length > 512 ? s.Substring(0, 512) : s; }
    static void Error(string stage, Exception e) { Errors.Add(stage + ": " + e.GetType().Name + " / 0x" + e.HResult.ToString("X8")); }
    static object[] Query(string query, string[] fields) {
        var rows = new List<object>();
        try {
            var options = new EnumerationOptions(); options.Timeout = TimeSpan.FromSeconds(10);
            using (var search = new ManagementObjectSearcher("root\\cimv2", query, options))
            using (var values = search.Get()) {
                foreach (ManagementObject value in values) {
                    var row = Map(); foreach (string field in fields) row[field] = Short(value[field]); rows.Add(row);
                    if (rows.Count >= 16) break;
                }
            }
        } catch (Exception e) { Error("host-query", e); }
        return rows.ToArray();
    }
    static string Hash(string file) {
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var sha = SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    }
    static bool NonAscii(string value) { foreach (char c in value) if (c > 127) return true; return false; }
    static string FindKernel() {
        string configured = Environment.GetEnvironmentVariable("CIKE_CAMOUFOX_EXECUTABLE");
        if (!String.IsNullOrWhiteSpace(configured)) return configured;
        string data = Environment.GetEnvironmentVariable("LFB_DATA");
        if (String.IsNullOrWhiteSpace(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CIKE");
        string marker = Path.Combine(data, "browsers", "camoufox-executable.txt");
        return File.Exists(marker) ? File.ReadAllText(marker, Encoding.UTF8).Trim() : "";
    }
    static object[] CheckFiles(string root, IEnumerable files) {
        var results = new List<object>(); string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        foreach (object item in files) {
            var expected = (Dictionary<string, object>)item; string relative = Text(expected["name"]);
            string file = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (Path.IsPathRooted(relative) || !file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid reference path");
            var result = Map(); result["name"] = relative;
            try {
                if (!File.Exists(file)) result["status"] = "missing";
                else if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) result["status"] = "link-skipped";
                else {
                    string actual = Hash(file); result["status"] = actual == Text(expected["sha256"]) ? "match" : "changed";
                    if (Text(result["status"]) != "match") result["actualSha256"] = actual;
                }
            } catch (Exception e) { result["status"] = "unreadable"; result["error"] = e.GetType().Name; }
            results.Add(result);
        }
        return results.ToArray();
    }
    static object KernelInfo(string executable, Dictionary<string, object> reference) {
        var result = Map(); result["found"] = File.Exists(executable); result["referenceBuild"] = reference["build"];
        if (!File.Exists(executable)) return result;
        result["nonAsciiPath"] = NonAscii(executable); result["pathLength"] = executable.Length;
        result["files"] = CheckFiles(Path.GetDirectoryName(executable), (IEnumerable)reference["files"]);
        var flags = new List<string>();
        string inherited = Environment.GetEnvironmentVariable("__COMPAT_LAYER") ?? "";
        foreach (RegistryKey hive in new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine }) {
            try { using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers")) {
                if (key != null) inherited += " " + Text(key.GetValue(executable));
            } } catch (Exception e) { Error("compatibility-flags", e); }
        }
        foreach (string flag in new string[] { "WIN7RTM", "WIN8RTM", "VISTARTM", "WINXPSP3", "RUNASADMIN", "HIGHDPIAWARE", "DPIUNAWARE", "DISABLEDXMAXIMIZEDWINDOWEDMODE" })
            if (inherited.IndexOf(flag, StringComparison.OrdinalIgnoreCase) >= 0) flags.Add(flag);
        result["compatibilityFlags"] = flags.ToArray(); return result;
    }
    static Dictionary<string, object> ParseCrash(string xml, string executable) {
        var document = new XmlDocument(); document.XmlResolver = null;
        var settings = new XmlReaderSettings(); settings.DtdProcessing = DtdProcessing.Prohibit; settings.XmlResolver = null;
        using (var reader = XmlReader.Create(new StringReader(xml), settings)) document.Load(reader);
        var fields = new Dictionary<string, string>();
        foreach (XmlNode node in document.SelectNodes("//*[local-name()='EventData']/*[local-name()='Data']")) {
            var name = node.Attributes["Name"]; if (name != null) fields[name.Value] = node.InnerText;
        }
        if (!fields.ContainsKey("AppName") || !String.Equals(fields["AppName"], "camoufox.exe", StringComparison.OrdinalIgnoreCase)) return null;
        if (!String.IsNullOrEmpty(executable) && fields.ContainsKey("AppPath") && !String.Equals(Path.GetFullPath(fields["AppPath"]), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase)) return null;
        var result = Map(); result["application"] = "camoufox.exe";
        if (fields.ContainsKey("ModuleName")) result["module"] = Path.GetFileName(fields["ModuleName"]);
        foreach (string field in CrashFields) if (fields.ContainsKey(field)) result[field] = Short(fields[field]);
        XmlNode time = document.SelectSingleNode("//*[local-name()='TimeCreated']/@SystemTime"); if (time != null) result["time"] = time.Value;
        return result;
    }
    static object[] CrashRecords(string executable) {
        var results = new List<object>();
        try {
            var query = new EventLogQuery("Application", PathType.LogName, "*[System[(EventID=1000) and TimeCreated[timediff(@SystemTime) <= 172800000]]]");
            query.ReverseDirection = true;
            using (var reader = new EventLogReader(query)) {
                int inspected = 0; EventRecord entry;
                while (results.Count < 12 && inspected++ < 512 && (entry = reader.ReadEvent()) != null) {
                    using (entry) { try { var result = ParseCrash(entry.ToXml(), executable); if (result != null) results.Add(result); } catch (Exception e) { Error("crash-record", e); } }
                }
            }
        } catch (Exception e) { Error("application-error-log", e); }
        return results.ToArray();
    }
    static void SelfTest() {
        string xml = "<Event><System><TimeCreated SystemTime='2026-11-08T00:00:00Z'/></System><EventData><Data Name='AppName'>camoufox.exe</Data><Data Name='AppPath'>D:\\private\\camoufox.exe</Data><Data Name='ModuleName'>D:\\private\\xul.dll</Data><Data Name='ExceptionCode'>c0000005</Data><Data Name='URL'>https://private.invalid/secret</Data><Data Name='Password'>secret</Data></EventData></Event>";
        var parsed = ParseCrash(xml, @"D:\private\camoufox.exe"); string serialized = Json.Serialize(parsed);
        if (parsed == null || Text(parsed["module"]) != "xul.dll" || Text(parsed["ExceptionCode"]) != "c0000005" || serialized.Contains("private") || serialized.Contains("secret")) throw new Exception("Crash record filtering failed");
        if (ParseCrash(xml, @"C:\other\camoufox.exe") != null || ParseCrash(xml.Replace("camoufox.exe", "other.exe"), "") != null) throw new Exception("Other process filtering failed");
        string root = Path.Combine(Path.GetTempPath(), "cike-report-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try {
            string file = Path.Combine(root, "fixture.dll"); File.WriteAllText(file, "fixture");
            var item = Map(); item["name"] = "fixture.dll"; item["sha256"] = Hash(file); object[] files = { item };
            if (Text(((Dictionary<string, object>)CheckFiles(root, files)[0])["status"]) != "match") throw new Exception("Integrity match failed");
            File.WriteAllText(file, "changed"); if (Text(((Dictionary<string, object>)CheckFiles(root, files)[0])["status"]) != "changed") throw new Exception("Integrity mismatch failed");
            File.Delete(file); if (Text(((Dictionary<string, object>)CheckFiles(root, files)[0])["status"]) != "missing") throw new Exception("Missing file check failed");
        } finally { Directory.Delete(root, true); }
        string probe = Path.Combine(Path.GetTempPath(), "cike-process-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(probe);
        try {
            string fixture = Path.Combine(probe, "camoufox.exe"); File.Copy(typeof(CikeCoreReport).Assembly.Location, fixture);
            using (var capture = new ExitCapture(fixture, false)) {
                var start = new ProcessStartInfo(fixture, "--exit-fixture 37"); start.UseShellExecute = false; start.CreateNoWindow = true;
                using (var child = Process.Start(start)) if (!child.WaitForExit(10000)) { child.Kill(); throw new Exception("Observer fixture timed out"); }
                bool observed = false;
                for (int attempt=0; attempt<100 && !observed; attempt++) {
                    foreach (Dictionary<string, object> row in capture.Results()) if (Text(row["exitStatus"]) == "0x00000025") observed = true;
                    if (!observed) Thread.Sleep(50);
                }
                if (!observed) throw new Exception("Native child exit status was not captured");
            }
        } finally { Directory.Delete(probe, true); }
        AccessSelfTest();
        Console.WriteLine("Windows core report self-test passed");
    }
    public static int Main(string[] args) {
        bool pause = args.Length == 0;
        try {
            if (args.Length == 2 && args[0] == "--exit-fixture") { Thread.Sleep(500); return Int32.Parse(args[1]); }
            if (args.Length == 1 && args[0] == "--self-test") { SelfTest(); return 0; }
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("CIKE 内核诊断 v5（执行权限、离线渲染与实际窗口观察）");
            Console.WriteLine("正在读取系统错误和校验内核文件，请稍候…");
            string executable = FindKernel(), output = ""; bool probe = pause;
            for (int i = 0; i < args.Length; i++) { if (args[i] == "--kernel" && i + 1 < args.Length) executable = args[++i]; else if (args[i] == "--output" && i + 1 < args.Length) output = args[++i]; else if (args[i] == "--probe") probe = true; else throw new ArgumentException("Invalid argument"); }
            Dictionary<string, object> reference;
            using (var resource = typeof(CikeCoreReport).Assembly.GetManifestResourceStream("CIKE.KernelHashes.json"))
            using (var reader = new StreamReader(resource, Encoding.UTF8)) reference = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            var report = Map(); report["format"] = 1; report["toolVersion"] = 5; report["time"] = DateTime.UtcNow.ToString("o");
            report["os"] = Query("SELECT Version,BuildNumber,OSArchitecture FROM Win32_OperatingSystem", new string[] { "Version", "BuildNumber", "OSArchitecture" });
            report["cpu"] = Query("SELECT Name,NumberOfCores,NumberOfLogicalProcessors FROM Win32_Processor", new string[] { "Name", "NumberOfCores", "NumberOfLogicalProcessors" });
            report["graphics"] = Query("SELECT Name,DriverVersion FROM Win32_VideoController", new string[] { "Name", "DriverVersion" });
            report["ansiCodePage"] = GetACP();
            var memory = new MemoryStatus(); if (GlobalMemoryStatusEx(memory)) {
                var values = Map(); values["physicalMiB"] = memory.TotalPhysical / 1048576; values["availablePhysicalMiB"] = memory.AvailablePhysical / 1048576;
                values["commitLimitMiB"] = memory.CommitLimit / 1048576; values["availableCommitMiB"] = memory.AvailableCommit / 1048576; report["memory"] = values;
            }
            report["kernel"] = KernelInfo(executable, reference); report["applicationErrors"] = CrashRecords(executable);
            Console.WriteLine("正在只读检查目录、DLL 执行权限和低完整性令牌访问…");
            report["loaderAccess"] = AccessReport(executable, reference);
            report["launchPolicies"] = LaunchPolicies(executable);
            bool verified = File.Exists(executable);
            if (verified) foreach (Dictionary<string, object> file in (object[])((Dictionary<string, object>)report["kernel"])["files"]) if (Text(file["status"]) != "match") verified = false;
            if (probe && verified) {
                Console.WriteLine("正在用临时环境测试本地页面（默认渲染，最长 25 秒）…");
                object first = RenderProbe(executable, false);
                Console.WriteLine("正在用另一个临时环境测试本地页面（软件渲染，最长 25 秒）…");
                object second=RenderProbe(executable,true);
                Console.WriteLine("正在自动观察两个临时浏览器窗口（各 12 秒），无需操作，窗口会自动关闭…");
                report["renderProbes"] = new object[] { first, second, RenderProbe(executable,false,true), RenderProbe(executable,true,true) };
            } else if (probe) report["renderProbeSkipped"] = "kernel-not-verified";
            report["securityEvents"] = SecurityRecords(executable);
            report["errors"] = Errors.ToArray();
            if (String.IsNullOrEmpty(output)) output = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "CIKE-Camoufox-report-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
            File.WriteAllText(output, Json.Serialize(report), new UTF8Encoding(false));
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("诊断已保存到：" + output);
            Console.WriteLine("请将这份 JSON 报告发回。工具没有修改现有环境、内核权限或系统安全设置。");
            return 0;
        } catch (Exception e) {
            Console.Error.WriteLine("Diagnostic failed: " + e.GetType().Name + " / 0x" + e.HResult.ToString("X8"));
            // Developer-only fixture failures contain no user report. Keep the
            // normal interactive error path free of paths and command lines.
            if (args.Length==1 && args[0]=="--self-test") Console.Error.WriteLine(e.ToString());
            return 1;
        }
        finally { if (pause) { Console.WriteLine("按回车关闭窗口"); Console.ReadLine(); } }
    }
}
