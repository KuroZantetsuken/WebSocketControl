using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

class Program
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int VK_NUMLOCK = 0x90;

    private static IntPtr _hookID = IntPtr.Zero;
    private static LowLevelKeyboardProc? _proc;

    private static readonly ConcurrentDictionary<TcpClient, bool> _clients = new();

    static async Task Main(string[] args)
    {
        _proc = HookCallback;
        _hookID = SetHook(_proc);

        _ = Task.Run(StartServerAsync);

        while (GetMessage(out MSG msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        UnhookWindowsHookEx(_hookID);
    }

    private static IntPtr SetHook(LowLevelKeyboardProc proc)
    {
        using var curProcess = Process.GetCurrentProcess();
        using var curModule = curProcess.MainModule;
        if (curModule?.ModuleName == null) return IntPtr.Zero;
        return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
        {
            int vkCode = Marshal.ReadInt32(lParam);
            if (vkCode == VK_NUMLOCK)
            {
                _ = Task.Run(BroadcastToggleMuteAsync);
            }
        }
        return CallNextHookEx(_hookID, nCode, wParam, lParam);
    }

    private static async Task BroadcastToggleMuteAsync()
    {
        var message = "{\"command\": \"TOGGLE_MUTE\"}";
        var frame = MakeFrame(message);

        foreach (var client in _clients.Keys)
        {
            try
            {
                if (client.Connected && _clients[client])
                {
                    var stream = client.GetStream();
                    await stream.WriteAsync(frame, 0, frame.Length, CancellationToken.None);
                    await stream.FlushAsync();
                }
            }
            catch (Exception)
            {
                _clients.TryRemove(client, out _);
                try { client.Close(); } catch { }
            }
        }
    }

    private static byte[] MakeFrame(string message)
    {
        var msgBytes = Encoding.UTF8.GetBytes(message);
        var msgLen = msgBytes.Length;
        byte[] frame;

        if (msgLen < 126)
        {
            frame = new byte[2 + msgLen];
            frame[0] = 0x81;
            frame[1] = (byte)msgLen;
            Buffer.BlockCopy(msgBytes, 0, frame, 2, msgLen);
        }
        else if (msgLen < 65536)
        {
            frame = new byte[4 + msgLen];
            frame[0] = 0x81;
            frame[1] = 126;
            frame[2] = (byte)((msgLen >> 8) & 0xFF);
            frame[3] = (byte)(msgLen & 0xFF);
            Buffer.BlockCopy(msgBytes, 0, frame, 4, msgLen);
        }
        else
        {
            throw new Exception("Message too long");
        }
        return frame;
    }

    private static async Task StartServerAsync()
    {
        TcpListener? listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Parse("127.0.0.1"), 8125);
            listener.Start();
        }
        catch (Exception)
        {
            return;
        }

        while (true)
        {
            try
            {
                var client = await listener.AcceptTcpClientAsync();
                _clients.TryAdd(client, false);
                _ = Task.Run(() => HandleClientAsync(client));
            }
            catch (Exception)
            {
            }
        }
    }

    private static async Task HandleClientAsync(TcpClient client)
    {
        var buffer = new byte[8192];
        var stream = client.GetStream();

        try
        {
            while (client.Connected)
            {
                int received = await stream.ReadAsync(buffer, 0, buffer.Length, CancellationToken.None);
                if (received <= 0) break;

                var data = Encoding.UTF8.GetString(buffer, 0, received);
                
                if (!_clients[client])
                {
                    var lines = data.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                    string? key = null;
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Sec-WebSocket-Key: ", StringComparison.OrdinalIgnoreCase))
                        {
                            key = line.Substring(19).Trim();
                            break;
                        }
                    }

                    if (key != null)
                    {
                        var magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
                        var acceptKey = Convert.ToBase64String(SHA1.HashData(Encoding.UTF8.GetBytes(key + magic)));

                        var response = "HTTP/1.1 101 Switching Protocols\r\n"
                                     + "Upgrade: websocket\r\n"
                                     + "Connection: Upgrade\r\n"
                                     + $"Sec-WebSocket-Accept: {acceptKey}\r\n\r\n";
                                     
                        var respBytes = Encoding.UTF8.GetBytes(response);
                        await stream.WriteAsync(respBytes, 0, respBytes.Length, CancellationToken.None);
                        await stream.FlushAsync();
                        
                        _clients[client] = true;
                    }
                    else
                    {
                        break;
                    }
                }
            }
        }
        catch (Exception)
        {
        }
        finally
        {
            _clients.TryRemove(client, out _);
            try { client.Close(); } catch { }
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int x;
        public int y;
    }

    [DllImport("user32.dll")]
    public static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref MSG lpMsg);
}