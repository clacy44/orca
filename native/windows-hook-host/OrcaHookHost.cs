// Windowless, stdin-capable Windows lifecycle-hook host (R105-b).
//
// Why this exists: Claude's Windows exec-form hook spawns this .exe directly (no shell), with
// windowsHide:true and stdin as a pipe carrying the event JSON. A console-subsystem child
// (curl.exe, cmd.exe) has no console to inherit and Windows allocates one per event — that is
// the flash R105 diagnosed. This binary is /target:winexe (GUI subsystem: no console is ever
// allocated for it) and does the HTTP POST in-process instead of shelling out.
//
// NEVER call System.Console.* here (it can allocate a console even in a winexe on some
// runtimes) and NEVER Process.Start a child (reintroduces the flash). Every exception is
// swallowed; this always exits 0 and writes nothing to stdout/stderr — a broken hook host must
// never surface as a Claude-visible error or a blocked tool call.
//
// TS mirror (line-for-line counterpart, kept in sync manually):
//   src/main/agent-hooks/windows-hook-host-mirror.ts
// Each method below names the mirror function it corresponds to.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class OrcaHookHost
{
    private const int StdinDeadlineMilliseconds = 2000;
    // Bounds raw stdin bytes read from Claude, not the encoded POST body: percent-encoding a
    // JSON payload (BuildFormBody) grows it roughly 1.6-2.2x, and HOOK_REQUEST_MAX_BYTES
    // (agent-hook-listener.ts:82) bounds that larger encoded body server-side — the two limits
    // are deliberately different quantities, not a shared cap.
    private const int StdinCapBytes = 1000000;
    // Why: HttpWebRequest has no separate connect/total timeout knobs for a plain synchronous
    // request; 1500ms approximates the spec's "connect 500ms, total 1500ms" as one total budget
    // (see docs/windows-hook-host.md — R-note, unverified on this box).
    private const int RequestTimeoutMilliseconds = 1500;
    // Source of truth: hook-settings.ts WINDOWS_HOOK_HOST_DESCRIPTOR_FIELDS — keep in sync by hand (D-R167 M-4).
    private static readonly string[] DefaultDescriptorFields =
    {
        "paneKey", "tabId", "launchToken", "worktreeId", "env", "version", "payload"
    };
    private const string DefaultDescriptorPathname = "/hook/claude";

    // Why not readonly field initializers: a Regex constructor can throw (malformed pattern),
    // and no static initializer here may be able to throw — that would raise before Main's
    // try/catch runs and surface as a Windows Error Reporting dialog. Constructed inside Main's
    // try instead; PortPattern/PathnamePattern are also RegexOptions.None (no .Compiled), which
    // is unnecessary JIT cost for a process that runs the pattern once and exits.
    private static Regex s_portPattern;
    private static Regex s_pathnamePattern;

    private static int Main(string[] args)
    {
        // Why: every path below is best-effort; the hook host must never block a tool call or
        // surface an error to Claude.
        try
        {
            s_portPattern = new Regex(@"^\d{1,5}$");
            s_pathnamePattern = new Regex(@"^/[A-Za-z0-9._~/-]*$");
            Run(args);
        }
        catch
        {
            // Swallow everything — see file header.
        }
        return 0;
    }

    // Counterpart: windows-hook-host-mirror.ts `runWindowsHookHostOnce`.
    private static void Run(string[] args)
    {
        string descriptorPath = ExpandDescriptorPath(args);

        // Counterpart: `resolveWindowsHookHostContext`.
        string endpointFileContents = ReadEndpointFileContents();
        EndpointCoordinates coordinates = ResolveCoordinates(endpointFileContents);
        string paneKey = Environment.GetEnvironmentVariable("ORCA_PANE_KEY");
        if (coordinates == null || string.IsNullOrEmpty(paneKey))
        {
            return;
        }

        // Counterpart: `readWindowsHookHostStdin`.
        string payload = ReadStdinWithDeadline(StdinDeadlineMilliseconds, StdinCapBytes);

        // Counterpart: `parseWindowsHookHostDescriptor`.
        Descriptor descriptor = ParseDescriptor(descriptorPath);

        // Counterpart: `buildWindowsHookHostFormBody`.
        string body = BuildFormBody(
            descriptor.Fields,
            paneKey,
            Environment.GetEnvironmentVariable("ORCA_TAB_ID"),
            Environment.GetEnvironmentVariable("ORCA_AGENT_LAUNCH_TOKEN"),
            Environment.GetEnvironmentVariable("ORCA_WORKTREE_ID"),
            coordinates.Env,
            coordinates.Version,
            payload
        );

        // Counterpart: `postWindowsHookHostPayload`.
        PostPayload(coordinates.Port, coordinates.Token, descriptor.Pathname, body);
    }

    // args: `--descriptor <path>`; expands %VARS% (Claude's exec-form spawner never expands
    // args itself — only this process's own CreateProcess-inherited environment does).
    private static string ExpandDescriptorPath(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i += 1)
        {
            if (string.Equals(args[i], "--descriptor", StringComparison.Ordinal))
            {
                return Environment.ExpandEnvironmentVariables(args[i + 1]);
            }
        }
        return null;
    }

    private static string ReadEndpointFileContents()
    {
        string endpointFilePath = Environment.GetEnvironmentVariable("ORCA_AGENT_HOOK_ENDPOINT");
        if (string.IsNullOrEmpty(endpointFilePath) || !File.Exists(endpointFilePath))
        {
            return null;
        }
        try
        {
            return File.ReadAllText(endpointFilePath);
        }
        catch
        {
            return null;
        }
    }

    private sealed class EndpointCoordinates
    {
        public string Port;
        public string Token;
        public string Env;
        public string Version;
    }

    // Counterpart: windows-hook-host-mirror.ts `parseWindowsHookHostEndpointFile` +
    // `resolveWindowsHookHostContext`. Mirrors src/shared/agent-hook-endpoint-file.ts:25-61's
    // `set K=V` CRLF parsing and port guard (^\d{1,5}$).
    private static EndpointCoordinates ResolveCoordinates(string endpointFileContents)
    {
        EndpointCoordinates fromFile = endpointFileContents != null
            ? ParseEndpointFile(endpointFileContents)
            : null;

        EndpointCoordinates coordinates = fromFile ?? new EndpointCoordinates
        {
            Port = Environment.GetEnvironmentVariable("ORCA_AGENT_HOOK_PORT"),
            Token = Environment.GetEnvironmentVariable("ORCA_AGENT_HOOK_TOKEN"),
            Env = Environment.GetEnvironmentVariable("ORCA_AGENT_HOOK_ENV"),
            Version = Environment.GetEnvironmentVariable("ORCA_AGENT_HOOK_VERSION")
        };

        if (string.IsNullOrEmpty(coordinates.Port) || string.IsNullOrEmpty(coordinates.Token))
        {
            return null;
        }
        // M2: the env-fallback port is otherwise unvalidated — an unvalidated port string is
        // interpolated straight into the request URL (PostPayload's string.Format) where a
        // crafted value could redirect the POST off 127.0.0.1.
        if (!s_portPattern.IsMatch(coordinates.Port))
        {
            return null;
        }
        return coordinates;
    }

    private static EndpointCoordinates ParseEndpointFile(string contents)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string rawLine in contents.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string line = rawLine.Trim();
            if (line.Length == 0)
            {
                continue;
            }
            if (line.StartsWith("set ", StringComparison.OrdinalIgnoreCase))
            {
                line = line.Substring(4);
            }
            int separatorIndex = line.IndexOf('=');
            if (separatorIndex < 0)
            {
                continue;
            }
            string key = line.Substring(0, separatorIndex);
            string value = line.Substring(separatorIndex + 1);
            values[key] = value;
        }

        string port;
        values.TryGetValue("ORCA_AGENT_HOOK_PORT", out port);
        if (string.IsNullOrEmpty(port) || !s_portPattern.IsMatch(port))
        {
            return null;
        }
        string token;
        values.TryGetValue("ORCA_AGENT_HOOK_TOKEN", out token);
        if (string.IsNullOrEmpty(token))
        {
            return null;
        }
        string env;
        values.TryGetValue("ORCA_AGENT_HOOK_ENV", out env);
        string version;
        values.TryGetValue("ORCA_AGENT_HOOK_VERSION", out version);
        return new EndpointCoordinates { Port = port, Token = token, Env = env, Version = version };
    }

    // P/Invoke stdin: avoids Console.OpenStandardInput, whose console-allocation behavior in a
    // winexe process could not be verified on this build box (see docs/windows-hook-host.md).
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);
    private const int StdInputHandle = -10;

    private static string ReadStdinWithDeadline(int deadlineMilliseconds, int capBytes)
    {
        IntPtr handle = GetStdHandle(StdInputHandle);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            return string.Empty;
        }

        var safeHandle = new SafeFileHandle(handle, false);
        var buffer = new MemoryStream();
        var stopSignal = new ManualResetEvent(false);
        FileStream stdin = null;

        var readerThread = new Thread(() =>
        {
            try
            {
                stdin = new FileStream(safeHandle, FileAccess.Read, 4096, false);
                var chunk = new byte[4096];
                int read;
                while ((read = stdin.Read(chunk, 0, chunk.Length)) > 0)
                {
                    int remaining = capBytes - (int)buffer.Length;
                    if (remaining <= 0)
                    {
                        break;
                    }
                    buffer.Write(chunk, 0, Math.Min(read, remaining));
                    if (buffer.Length >= capBytes)
                    {
                        break;
                    }
                }
            }
            catch
            {
                // A forced Close() from the deadline path throws here — expected, not an error.
            }
            finally
            {
                stopSignal.Set();
            }
        });
        readerThread.IsBackground = true;
        readerThread.Start();

        stopSignal.WaitOne(deadlineMilliseconds);
        try
        {
            if (stdin != null)
            {
                stdin.Close();
            }
        }
        catch
        {
            // best-effort
        }
        try
        {
            // M5: Close() unblocks the reader thread's Read() call but does not wait for it to
            // finish tearing down; without a join, ToArray() below can race the reader thread's
            // last Write() into `buffer` and lose the tail of the payload.
            readerThread.Join(200);
        }
        catch
        {
            // best-effort
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private sealed class Descriptor
    {
        public string Pathname;
        public string[] Fields;
    }

    private static readonly Descriptor BuiltInDescriptor = new Descriptor
    {
        Pathname = DefaultDescriptorPathname,
        Fields = DefaultDescriptorFields
    };

    // Counterpart: `parseWindowsHookHostDescriptor`. Falls open to BuiltInDescriptor on any
    // read/parse failure — a missing or corrupt descriptor must never stop the POST.
    // Why hand-rolled regex, not a JSON library: the descriptor is self-authored by
    // hook-service.ts in one fixed, flat shape; a full parser would be an external dependency
    // this file deliberately avoids.
    private static Descriptor ParseDescriptor(string descriptorPath)
    {
        if (string.IsNullOrEmpty(descriptorPath) || !File.Exists(descriptorPath))
        {
            return BuiltInDescriptor;
        }
        try
        {
            string json = File.ReadAllText(descriptorPath);
            Match pathnameMatch = Regex.Match(json, "\"pathname\"\\s*:\\s*\"([^\"]*)\"");
            Match fieldsMatch = Regex.Match(json, "\"fields\"\\s*:\\s*\\[([^\\]]*)\\]");
            if (!pathnameMatch.Success || !fieldsMatch.Success)
            {
                return BuiltInDescriptor;
            }

            var fields = new List<string>();
            foreach (Match fieldMatch in Regex.Matches(fieldsMatch.Groups[1].Value, "\"([^\"]*)\""))
            {
                fields.Add(fieldMatch.Groups[1].Value);
            }
            if (fields.Count == 0)
            {
                return BuiltInDescriptor;
            }

            // M2: an unvalidated Pathname is interpolated straight into the request URL
            // (PostPayload's string.Format) — a crafted `@evil.example/x` value can turn the
            // URL's authority into an attacker host, leaking the token and payload off-box.
            string pathname = pathnameMatch.Groups[1].Value;
            if (!s_pathnamePattern.IsMatch(pathname))
            {
                return BuiltInDescriptor;
            }

            return new Descriptor
            {
                Pathname = pathname,
                Fields = fields.ToArray()
            };
        }
        catch
        {
            return BuiltInDescriptor;
        }
    }

    // Field order/source exactly mirrors buildWindowsAgentHookCurlPostCommand
    // (installer-utils.ts:182-198): paneKey, tabId, launchToken, worktreeId, env, version, payload.
    private static string BuildFormBody(
        string[] fields,
        string paneKey,
        string tabId,
        string launchToken,
        string worktreeId,
        string env,
        string version,
        string payload)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "paneKey", paneKey },
            { "tabId", tabId },
            { "launchToken", launchToken },
            { "worktreeId", worktreeId },
            { "env", env },
            { "version", version },
            { "payload", payload }
        };

        var builder = new StringBuilder();
        for (int i = 0; i < fields.Length; i += 1)
        {
            if (i > 0)
            {
                builder.Append('&');
            }
            string value;
            values.TryGetValue(fields[i], out value);
            builder.Append(EncodeRfc3986(fields[i]));
            builder.Append('=');
            builder.Append(EncodeRfc3986(value ?? string.Empty));
        }
        return builder.ToString();
    }

    // H2: hand-rolled RFC-3986 percent-encoder over UTF-8 bytes, replacing Uri.EscapeDataString
    // (which throws on inputs over ~65,520 chars in .NET Framework — c_MaxUriBufferSize — and
    // that throw would be swallowed by Main's blanket catch, silently dropping the POST for any
    // large tool payload). Unreserved set per RFC 3986: A-Z a-z 0-9 - . _ ~.
    private static string EncodeRfc3986(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        var builder = new StringBuilder(bytes.Length);
        for (int i = 0; i < bytes.Length; i += 1)
        {
            byte b = bytes[i];
            bool isUnreserved =
                (b >= (byte)'A' && b <= (byte)'Z') ||
                (b >= (byte)'a' && b <= (byte)'z') ||
                (b >= (byte)'0' && b <= (byte)'9') ||
                b == (byte)'-' || b == (byte)'.' || b == (byte)'_' || b == (byte)'~';
            if (isUnreserved)
            {
                builder.Append((char)b);
            }
            else
            {
                builder.Append('%');
                builder.Append(HexDigit(b >> 4));
                builder.Append(HexDigit(b & 0xF));
            }
        }
        return builder.ToString();
    }

    private static char HexDigit(int nibble)
    {
        return (char)(nibble < 10 ? '0' + nibble : 'A' + (nibble - 10));
    }

    // Counterpart: `postWindowsHookHostPayload`. Every exception here is caught by Main's
    // top-level try/catch — this method intentionally does not catch its own.
    private static void PostPayload(string port, string token, string pathname, string body)
    {
        var request = (HttpWebRequest)WebRequest.Create(
            string.Format("http://127.0.0.1:{0}{1}", port, pathname));
        request.Method = "POST";
        request.ContentType = "application/x-www-form-urlencoded";
        request.Headers["X-Orca-Agent-Hook-Token"] = token;
        // M1: this is a fixed loopback POST — no proxy, no Expect: 100-continue round trip, and
        // no redirect following (a redirect response would otherwise re-send the token header
        // to whatever Location a compromised local listener names).
        request.Proxy = null;
        request.ServicePoint.Expect100Continue = false;
        request.AllowAutoRedirect = false;
        // Why: HttpWebRequest has no independent connect-phase timeout for a plain sync
        // request; this bounds the whole call (see RequestTimeoutMilliseconds comment above).
        request.Timeout = RequestTimeoutMilliseconds;

        byte[] bodyBytes = Encoding.UTF8.GetBytes(body);
        request.ContentLength = bodyBytes.Length;
        using (Stream requestStream = request.GetRequestStream())
        {
            requestStream.Write(bodyBytes, 0, bodyBytes.Length);
        }
        // L2: response is intentionally unread — fire-and-forget status reporting; the `using`
        // still disposes it without naming an unused local.
        using (request.GetResponse())
        {
        }
    }
}
