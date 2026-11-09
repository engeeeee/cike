using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Diagnostics;
using System.Threading;
using System.Text.RegularExpressions;

public static class CikeCoreRepair {
    public static int Main(string[] args) { return CikeCoreReport.RepairMain(args); }
}

public static partial class CikeCoreReport {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    class KernelItem { public string Relative; public long Bytes; public bool Directory; }
    static bool SamePath(string first,string second) { return String.Equals(Path.GetFullPath(first).TrimEnd('\\'),Path.GetFullPath(second).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase); }
    static bool Under(string parent,string child) { return SamePath(parent,child) || Path.GetFullPath(child).StartsWith(Path.GetFullPath(parent).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase); }
    static void NoLinks(string path) {
        string full=Path.GetFullPath(path);
        for (var directory=new DirectoryInfo(full); directory!=null; directory=directory.Parent)
            if (directory.Exists && (directory.Attributes & FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("路径包含链接，未执行修复");
    }
    static void MediumReadOnlyLabel(string path,bool directory,bool denyRead=false) {
        IntPtr descriptor=IntPtr.Zero,sacl; uint size; bool present,inherited;
        try {
            string text="S:(ML;" + (directory ? "OICI" : "") + ";" + (denyRead ? "NWNRNX" : "NW") + ";;;ME)";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text,1,out descriptor,out size)) throw new Win32Exception();
            if (!GetSecurityDescriptorSacl(descriptor,out present,out sacl,out inherited) || !present) throw new Win32Exception();
            uint error=SetNamedSecurityInfoW(path,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl);
            if (error!=0) throw new Win32Exception((int)error);
        } finally { if (descriptor!=IntPtr.Zero) LocalFree(descriptor); }
    }
    static void PrivateRepairDirectory(string directory) {
        NoLinks(directory); Directory.CreateDirectory(directory);
        var acl=new DirectorySecurity(); acl.SetAccessRuleProtection(true,false);
        var user=WindowsIdentity.GetCurrent().User; acl.SetOwner(user);
        foreach (var sid in new SecurityIdentifier[] {user,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")})
            acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.SetAccessControl(directory,acl);
        // Medium/NW allows sandbox reads, prevents sandbox writes and retains
        // image-load protection against binaries labelled Low.
        MediumReadOnlyLabel(directory,true);
    }
    static List<KernelItem> KernelInventory(string root) {
        NoLinks(root); var result=new List<KernelItem>(); VisitKernel(root,"",result); return result;
    }
    static void VisitKernel(string root,string relative,List<KernelItem> result) {
        foreach (string file in Directory.EnumerateFileSystemEntries(Path.Combine(root,relative))) {
            string name=String.IsNullOrEmpty(relative) ? Path.GetFileName(file) : Path.Combine(relative,Path.GetFileName(file));
            if (String.IsNullOrEmpty(relative) && name==".cike-camoufox.json") continue;
            FileAttributes attributes=File.GetAttributes(file);
            if ((attributes & FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("内核包含链接，未执行修复");
            bool directory=(attributes & FileAttributes.Directory)!=0;
            result.Add(new KernelItem { Relative=name,Directory=directory,Bytes=directory ? 0 : new FileInfo(file).Length });
            if (directory) VisitKernel(root,name,result);
        }
    }
    static void CopyKernel(string source,string target,List<KernelItem> items) {
        long copied=0,next=0;
        foreach (var item in items) {
            string destination=Path.Combine(target,item.Relative);
            if (item.Directory) { Directory.CreateDirectory(destination); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            CopyRepairFile(Path.Combine(source,item.Relative),destination);
            if (Hash(Path.Combine(source,item.Relative))!=Hash(destination)) throw new InvalidDataException("内核副本校验失败");
            copied+=item.Bytes;
            if (copied>=next) { Console.WriteLine("已复制并校验 " + copied/1048576 + " MiB"); next=copied+268435456; }
        }
    }
    static void CopyRepairFile(string source,string destination) {
        // CopyFile can preserve security properties on Windows. Create new
        // streams so the copy inherits only the new private directory's ACL.
        using (var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read))
        using (var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { input.CopyTo(output,1048576); output.Flush(true); }
        MediumReadOnlyLabel(destination,false);
    }
    static void AssertOfficial(string executable,Dictionary<string,object> reference) {
        if (!File.Exists(executable)) throw new InvalidOperationException("没有找到已安装内核");
        foreach (Dictionary<string,object> row in CheckFiles(Path.GetDirectoryName(executable),(IEnumerable)reference["files"]))
            if (Text(row["status"])!="match") throw new InvalidOperationException("关键内核文件与官方基准不一致，未执行修复");
    }
    static Dictionary<string,object> ReadObject(string file) {
        if ((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("配置文件包含链接");
        return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
    }
    static Dictionary<string,object> ManagedStorage(string data,string source,out string entryId) {
        string browsers=Path.Combine(data,"browsers"),file=Path.Combine(browsers,"camoufox-storage.json"); NoLinks(browsers); NoLinks(source);
        if (Under(source,data) || Under(Path.Combine(data,"profiles"),source) || !Path.GetFileName(source).StartsWith("camoufox-",StringComparison.Ordinal)) throw new InvalidOperationException("内核路径不属于可修复范围");
        string selected=File.ReadAllText(Path.Combine(browsers,"camoufox-executable.txt"),Encoding.UTF8).Trim();
        if (!SamePath(selected,Path.Combine(source,"camoufox.exe"))) throw new InvalidOperationException("当前内核选择已变化，未执行修复");
        var storage=ReadObject(file);
        if (Convert.ToInt32(storage["format"])!=1 || !(storage["root"] is string) || !Path.IsPathRooted((string)storage["root"]) || !(storage["entries"] is IEnumerable)) throw new InvalidDataException("内核管理配置损坏");
        entryId=null;
        foreach (Dictionary<string,object> entry in (IEnumerable)storage["entries"]) {
            string id=Text(entry["id"]),directory=Text(entry["directory"]);
            if (!Regex.IsMatch(id,"^[a-f0-9]{32}$") || !Path.IsPathRooted(directory)) throw new InvalidDataException("内核管理记录损坏");
            if (SamePath(directory,source) && Text(entry["state"])=="ready") entryId=id;
        }
        if (entryId==null) throw new InvalidOperationException("不能确认这是 CIKE 管理的内核，未执行修复");
        var owner=ReadObject(Path.Combine(source,".cike-camoufox.json"));
        if (Text(owner["owner"])!="CIKE.Camoufox" || Text(owner["id"])!=entryId) throw new InvalidDataException("内核归属标记不匹配");
        return storage;
    }
    static void AtomicBytes(string file,byte[] contents) {
        string temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
        try {
            using (var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { stream.Write(contents,0,contents.Length); stream.Flush(true); }
            if (File.Exists(file)) File.Replace(temporary,file,null); else File.Move(temporary,file);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    static byte[] Utf8(string value) { return new UTF8Encoding(false).GetBytes(value); }
    static bool EqualBytes(byte[] first,byte[] second) {
        if (first.Length!=second.Length) return false; for (int i=0;i<first.Length;i++) if (first[i]!=second[i]) return false; return true;
    }
    static void CommitSelection(string data,Dictionary<string,object> storage,string target,string id,string build,Action afterMarker=null) {
        string browsers=Path.Combine(data,"browsers"),config=Path.Combine(browsers,"camoufox-storage.json"),marker=Path.Combine(browsers,"camoufox-executable.txt");
        NoLinks(browsers);
        byte[] beforeConfig=File.ReadAllBytes(config),beforeMarker=File.ReadAllBytes(marker);
        string backup=Path.Combine(browsers,"core-repair-backups",DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N"));
        PrivateRepairDirectory(backup);
        File.WriteAllBytes(Path.Combine(backup,"camoufox-storage.json"),beforeConfig); File.WriteAllBytes(Path.Combine(backup,"camoufox-executable.txt"),beforeMarker);
        var entries=new List<object>(); foreach (object entry in (IEnumerable)storage["entries"]) entries.Add(entry);
        var added=Map(); added["id"]=id; added["directory"]=target; added["version"]=build; added["state"]="ready"; entries.Add(added);
        var next=Map(); foreach (var pair in storage) next[pair.Key]=pair.Value; next["entries"]=entries.ToArray(); next["root"]=browsers;
        bool markerWritten=false,configWritten=false;
        try {
            if (!EqualBytes(beforeConfig,File.ReadAllBytes(config)) || !EqualBytes(beforeMarker,File.ReadAllBytes(marker))) throw new InvalidOperationException("内核配置已变化");
            AtomicBytes(marker,Utf8(Path.Combine(target,"camoufox.exe")+"\n")); markerWritten=true;
            if (afterMarker!=null) afterMarker();
            AtomicBytes(config,Utf8(Json.Serialize(next))); configWritten=true;
        } catch {
            if (configWritten) AtomicBytes(config,beforeConfig);
            if (markerWritten) AtomicBytes(marker,beforeMarker);
            throw;
        }
    }
    static bool NoAccessDenied(object[] probes) {
        foreach (Dictionary<string,object> probe in probes) {
            object values; if (!probe.TryGetValue("nativeProcessExits",out values)) return false;
            foreach (Dictionary<string,object> exit in (IEnumerable)values)
                if (Text(exit["exitStatus"])=="0xC0000022") return false;
        }
        return true;
    }
    static bool HealthyProbes(object[] probes) {
        if (probes.Length!=4 || !NoAccessDenied(probes)) return false;
        for (int i=0;i<probes.Length;i++) {
            var row=(Dictionary<string,object>)probes[i];
            if (i<2 ? Text(row["status"])!="painted" : Text(row["status"])!="observed" || !row.ContainsKey("visibleWindow") || !(bool)row["visibleWindow"]) return false;
        }
        return true;
    }
    static object[] RepairProbes(string executable) {
        Console.WriteLine("正在验证默认与软件离线渲染…");
        object first=RenderProbe(executable,false),second=RenderProbe(executable,true);
        Console.WriteLine("正在验证两个实际窗口，各观察 12 秒；无需操作…");
        return new object[] {first,second,RenderProbe(executable,false,true),RenderProbe(executable,true,true)};
    }
    static void RequireCikeClosed() {
        foreach (var process in Process.GetProcessesByName("CIKE")) { process.Dispose(); throw new InvalidOperationException("请完全退出 CIKE 后再运行修复工具"); }
    }
    static void CleanupRepair(string path) {
        if (!Directory.Exists(path)) return;
        for (int i=0;i<8;i++) try { Directory.Delete(path,true); return; } catch { if (i==7) throw; Thread.Sleep(250); }
    }
    static void RepairKernel(string data,string executable,Dictionary<string,object> reference,Dictionary<string,object> report,bool checkApp=true) {
        if (checkApp) RequireCikeClosed();
        string source=Path.GetDirectoryName(Path.GetFullPath(executable)),oldId; var storage=ManagedStorage(data,source,out oldId);
        AssertOfficial(executable,reference);
        var files=KernelInventory(source); long bytes=0; foreach (var item in files) bytes+=item.Bytes;
        string browsers=Path.Combine(data,"browsers"); NoLinks(browsers);
        string systemDrive=Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System));
        if (!SamePath(Path.GetPathRoot(browsers),systemDrive)) throw new InvalidOperationException("当前 CIKE 数据目录不在系统盘，未自动切换位置");
        if (new DriveInfo(systemDrive).AvailableFreeSpace<bytes+268435456) throw new InvalidOperationException("系统盘剩余空间不足，原内核未改变");
        string destination=Path.Combine(browsers,"camoufox-"+Text(reference["build"])+"-"+Guid.NewGuid().ToString("N").Substring(0,6));
        bool selected=false; report["status"]="checking"; report["sourceId"]=oldId;
        using (var low=new LowReadToken()) {
            report["beforeExecutable"]=ImageAccess(executable,low.Handle);
            report["beforeXul"]=ImageAccess(Path.Combine(source,"xul.dll"),low.Handle);
            report["sourcePermissions"]=AccessDescriptor(source,true);
            report["sourceExecutablePermissions"]=AccessDescriptor(executable,false);
            report["sourceXulPermissions"]=AccessDescriptor(Path.Combine(source,"xul.dll"),false);
            try {
                PrivateRepairDirectory(destination);
                // Test a small real executable before copying the whole core.
                string targetExe=Path.Combine(destination,"camoufox.exe");
                CopyRepairFile(executable,targetExe);
                var access=ImageAccess(targetExe,low.Handle); report["destinationReadCheck"]=access;
                if (Text(access["status"])!="mapped") throw new InvalidOperationException("系统盘独立副本仍被低权限访问拒绝，未切换内核；需继续检查路径之外的访问控制");
                File.Delete(targetExe);
                Console.WriteLine("系统盘副本读取检查通过，正在复制并逐文件校验内核…");
                CopyKernel(source,destination,files);
                AssertOfficial(targetExe,reference);
                foreach (var item in files) if (!item.Directory && Regex.IsMatch(item.Relative,@"\.(exe|dll)$",RegexOptions.IgnoreCase)) {
                    var mapped=ImageAccess(Path.Combine(destination,item.Relative),low.Handle);
                    if (Text(mapped["status"])!="mapped") throw new InvalidOperationException("副本中仍有 DLL 无法被低权限读取，未切换内核");
                }
                object[] probes=RepairProbes(targetExe); report["verification"]=probes;
                if (!HealthyProbes(probes)) throw new InvalidOperationException("副本的页面或窗口验证未通过，原内核选择保持不变");
                string id=Guid.NewGuid().ToString("N"); File.WriteAllText(Path.Combine(destination,".cike-camoufox.json"),Json.Serialize(new Dictionary<string,object>{{"owner","CIKE.Camoufox"},{"id",id}}),new UTF8Encoding(false));
                // Refuse a concurrent app restart or a changed selection.
                if (checkApp) RequireCikeClosed();
                string now; var fresh=ManagedStorage(data,source,out now);
                if (now!=oldId || Json.Serialize(fresh)!=Json.Serialize(storage)) throw new InvalidOperationException("验证期间内核配置已变化，未切换");
                CommitSelection(data,storage,destination,id,Text(reference["build"])); selected=true;
                report["status"]="switched"; report["destinationId"]=id; report["bytes"]=bytes;
                report["destination"]="CIKE 默认内核目录（系统盘）"; report["previousCopyPreserved"]=true;
                Console.WriteLine("验证通过，已切换。新位置："+destination);
                Console.WriteLine("原内核副本与所有浏览器环境已保留；可重新打开 CIKE 使用原环境。");
            } finally { if (!selected) CleanupRepair(destination); }
        }
    }
    static Dictionary<string,object> EmbeddedReference() {
        using (var stream=typeof(CikeCoreReport).Assembly.GetManifestResourceStream("CIKE.KernelHashes.json"))
        using (var reader=new StreamReader(stream,Encoding.UTF8)) return Json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
    }
    public static int RepairMain(string[] args) {
        if (args.Length==2 && args[0]=="--exit-fixture") return Main(args);
        bool pause=args.Length==0; var report=Map(); report["format"]=1; report["repairVersion"]=1; report["time"]=DateTime.UtcNow.ToString("o");
        string output="";
        try {
            if (args.Length==2 && args[0]=="--self-test") { SelfTest(); RepairSelfTest(args[1],EmbeddedReference()); return 0; }
            if (args.Length!=0) throw new ArgumentException("Invalid argument");
            Console.OutputEncoding=Encoding.UTF8;
            Console.WriteLine("CIKE 内核目录修复 v1");
            Console.WriteLine("请保持 CIKE 已完全退出。仅在副本的读取、页面和窗口验证通过后切换。");
            string data=Environment.GetEnvironmentVariable("LFB_DATA");
            if (String.IsNullOrWhiteSpace(data)) data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CIKE");
            string configured=Environment.GetEnvironmentVariable("CIKE_CAMOUFOX_EXECUTABLE");
            if (!String.IsNullOrWhiteSpace(configured)) throw new InvalidOperationException("检测到外部内核环境变量，未改写其设置");
            RepairKernel(Path.GetFullPath(data),FindKernel(),EmbeddedReference(),report);
            return 0;
        } catch (Exception e) {
            report["status"]="not-switched"; report["error"]=e.GetType().Name; report["hresult"]="0x"+e.HResult.ToString("X8");
            Console.Error.WriteLine("未切换内核："+e.Message);
            if (args.Length>0) Console.Error.WriteLine(e.ToString());
            return 1;
        } finally {
            if (pause) {
                try { output=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"CIKE-Camoufox-repair-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+".json"); File.WriteAllText(output,Json.Serialize(report),new UTF8Encoding(false)); Console.WriteLine("结果报告："+output); } catch (Exception e) { Console.Error.WriteLine("报告保存失败："+e.GetType().Name); }
                Console.WriteLine("按回车关闭窗口"); Console.ReadLine();
            }
        }
    }
    static void RepairSelfTest(string executable,Dictionary<string,object> reference) {
        string root=Path.Combine(Path.GetTempPath(),"cike-repair-test-"+Guid.NewGuid().ToString("N")); PrivateRepairDirectory(root);
        try {
            string labelFile=Path.Combine(root,"label.exe"); CopyRepairFile(typeof(CikeCoreReport).Assembly.Location,labelFile);
            MediumReadOnlyLabel(labelFile,false,true);
            using (var low=new LowReadToken()) {
                if (Text(ImageAccess(labelFile,IntPtr.Zero)["status"])!="mapped" || Text(ImageAccess(labelFile,low.Handle)["status"])!="open-denied") throw new Exception("Mandatory read/execute denial fixture failed");
                var permissions=(Dictionary<string,object>)AccessDescriptor(labelFile,false); bool found=false; object labels;
                if (permissions.TryGetValue("mandatoryLabels",out labels)) foreach (Dictionary<string,object> label in (IEnumerable)labels)
                    if (Text(label["sid"])=="S-1-16-8192" && Text(label["mask"])=="0x00000007") found=true;
                if (!found) throw new Exception("Mandatory label was not exported: "+Json.Serialize(permissions));
                string clean=Path.Combine(root,"clean.exe"); CopyRepairFile(labelFile,clean);
                if (Hash(labelFile)!=Hash(clean) || Text(ImageAccess(clean,low.Handle)["status"])!="mapped") throw new Exception("Clean copy retained denied source label");
            }
            string data=Path.Combine(root,"data"),browsers=Path.Combine(data,"browsers"); Directory.CreateDirectory(browsers);
            string source=Path.Combine(root,"camoufox-broken-"+Guid.NewGuid().ToString("N").Substring(0,6)); PrivateRepairDirectory(source);
            Console.WriteLine("Preparing real kernel access-denied regression");
            var files=KernelInventory(Path.GetDirectoryName(executable)); CopyKernel(Path.GetDirectoryName(executable),source,files);
            foreach (var file in files) if (!file.Directory && file.Relative.EndsWith(".dll",StringComparison.OrdinalIgnoreCase)) MediumReadOnlyLabel(Path.Combine(source,file.Relative),false,true);
            string id=Guid.NewGuid().ToString("N");
            File.WriteAllText(Path.Combine(source,".cike-camoufox.json"),Json.Serialize(new Dictionary<string,object>{{"owner","CIKE.Camoufox"},{"id",id}}));
            var oldEntry=new Dictionary<string,object>{{"id",id},{"directory",source},{"version",reference["build"]},{"state","ready"}};
            var storage=new Dictionary<string,object>{{"format",1},{"root",Path.GetDirectoryName(source)},{"entries",new object[]{oldEntry}}};
            string config=Path.Combine(browsers,"camoufox-storage.json"),marker=Path.Combine(browsers,"camoufox-executable.txt");
            File.WriteAllText(config,Json.Serialize(storage),new UTF8Encoding(false)); File.WriteAllText(marker,Path.Combine(source,"camoufox.exe")+"\n",new UTF8Encoding(false));
            string profile=Path.Combine(data,"profiles","preserved"); Directory.CreateDirectory(profile);
            byte[] cookie=Utf8(Guid.NewGuid().ToString("N")); File.WriteAllBytes(Path.Combine(profile,"cookies.sqlite"),cookie);
            byte[] oldConfig=File.ReadAllBytes(config),oldMarker=File.ReadAllBytes(marker);
            // Exercise a failure between the two atomic config writes.
            bool injected=false;
            try { CommitSelection(data,storage,Path.Combine(root,"not-selected"),Guid.NewGuid().ToString("N"),Text(reference["build"]),delegate { injected=true; throw new IOException("fixture failure"); }); } catch (IOException) {}
            if (!injected || !EqualBytes(oldConfig,File.ReadAllBytes(config)) || !EqualBytes(oldMarker,File.ReadAllBytes(marker))) throw new Exception("Selection rollback failed");
            Console.WriteLine("Reproducing real sandbox child STATUS_ACCESS_DENIED");
            var broken=(Dictionary<string,object>)RenderProbe(Path.Combine(source,"camoufox.exe"),false);
            bool denied=false; object exitRows;
            if (broken.TryGetValue("nativeProcessExits",out exitRows)) foreach (Dictionary<string,object> exit in (IEnumerable)exitRows) if (Text(exit["exitStatus"])=="0xC0000022") denied=true;
            if (!denied) throw new Exception("Restricted core did not reproduce C0000022: "+Json.Serialize(broken));
            var result=Map(); RepairKernel(data,Path.Combine(source,"camoufox.exe"),reference,result,false);
            if (Text(result["status"])!="switched" || !HealthyProbes((object[])result["verification"])) throw new Exception("Real repair verification failed: "+Json.Serialize(result));
            string selected=File.ReadAllText(marker).Trim(),target=Path.GetDirectoryName(selected),ownedId;
            var updated=ManagedStorage(data,target,out ownedId); int count=0; foreach (object entry in (IEnumerable)updated["entries"]) count++;
            if (SamePath(target,source) || count!=2 || ownedId==id || !SamePath(Text(updated["root"]),browsers)) throw new Exception("Repaired kernel management metadata mismatch");
            if (!Directory.Exists(source) || !EqualBytes(cookie,File.ReadAllBytes(Path.Combine(profile,"cookies.sqlite")))) throw new Exception("Repair modified original kernel or profile");
            // This exercises the exact copy in the management record again.
            AssertOfficial(selected,reference);
            foreach (string file in Directory.EnumerateFiles(Path.Combine(browsers,"core-repair-backups"),"camoufox-storage.json",SearchOption.AllDirectories))
                if (!EqualBytes(oldConfig,File.ReadAllBytes(file))) throw new Exception("Original configuration backup mismatch");
            Console.WriteLine("Windows real kernel access-denied repair, preserved profile and rollback self-tests passed");
        } finally { CleanupRepair(root); }
    }
}
