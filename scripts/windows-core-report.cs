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
using Microsoft.Win32;

// Standalone .NET Framework 4 tool. Reads only host details, the selected
// kernel's files and that kernel's Application Error records. No browser is
// launched and no browser profile, proxy configuration or memory dump is read.
public static class CikeCoreReport {
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
        Console.WriteLine("Windows core report self-test passed");
    }
    public static int Main(string[] args) {
        bool pause = args.Length == 0;
        try {
            if (args.Length == 1 && args[0] == "--self-test") { SelfTest(); return 0; }
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("正在读取系统错误和校验内核文件，请稍候…");
            string executable = FindKernel(), output = "";
            for (int i = 0; i < args.Length; i++) { if (args[i] == "--kernel" && i + 1 < args.Length) executable = args[++i]; else if (args[i] == "--output" && i + 1 < args.Length) output = args[++i]; else throw new ArgumentException("Invalid argument"); }
            Dictionary<string, object> reference;
            using (var resource = typeof(CikeCoreReport).Assembly.GetManifestResourceStream("CIKE.KernelHashes.json"))
            using (var reader = new StreamReader(resource, Encoding.UTF8)) reference = Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            var report = Map(); report["format"] = 1; report["time"] = DateTime.UtcNow.ToString("o");
            report["os"] = Query("SELECT Version,BuildNumber,OSArchitecture FROM Win32_OperatingSystem", new string[] { "Version", "BuildNumber", "OSArchitecture" });
            report["cpu"] = Query("SELECT Name,NumberOfCores,NumberOfLogicalProcessors FROM Win32_Processor", new string[] { "Name", "NumberOfCores", "NumberOfLogicalProcessors" });
            report["graphics"] = Query("SELECT Name,DriverVersion FROM Win32_VideoController", new string[] { "Name", "DriverVersion" });
            report["ansiCodePage"] = GetACP();
            var memory = new MemoryStatus(); if (GlobalMemoryStatusEx(memory)) {
                var values = Map(); values["physicalMiB"] = memory.TotalPhysical / 1048576; values["availablePhysicalMiB"] = memory.AvailablePhysical / 1048576;
                values["commitLimitMiB"] = memory.CommitLimit / 1048576; values["availableCommitMiB"] = memory.AvailableCommit / 1048576; report["memory"] = values;
            }
            report["kernel"] = KernelInfo(executable, reference); report["applicationErrors"] = CrashRecords(executable); report["errors"] = Errors.ToArray();
            if (String.IsNullOrEmpty(output)) output = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "CIKE-Camoufox-report-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
            File.WriteAllText(output, Json.Serialize(report), new UTF8Encoding(false));
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("诊断已保存到：" + output);
            Console.WriteLine("请将这份 JSON 报告发回。工具没有修改浏览器环境或内核。");
            return 0;
        } catch (Exception e) { Console.Error.WriteLine("Diagnostic failed: " + e.GetType().Name + " / 0x" + e.HResult.ToString("X8")); return 1; }
        finally { if (pause) { Console.WriteLine("按回车关闭窗口"); Console.ReadLine(); } }
    }
}
