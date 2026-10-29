$ErrorActionPreference = 'Stop'

if (-not ('CongressSQLite' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CongressSQLite : IDisposable
{
    private IntPtr db;
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int Callback(IntPtr context, int count, IntPtr values, IntPtr names);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2(byte[] path, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_exec(IntPtr db, byte[] sql, Callback callback, IntPtr context, out IntPtr error);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void sqlite3_free(IntPtr ptr);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr db);

    private static byte[] Utf8(string value) { return Encoding.UTF8.GetBytes(value + "\0"); }
    private static string Text(IntPtr ptr)
    {
        if (ptr == IntPtr.Zero) return null;
        int length = 0;
        while (Marshal.ReadByte(ptr, length) != 0) length++;
        byte[] bytes = new byte[length];
        Marshal.Copy(ptr, bytes, 0, length);
        return Encoding.UTF8.GetString(bytes);
    }

    public CongressSQLite(string path)
    {
        int result = sqlite3_open_v2(Utf8(path), out db, 6, IntPtr.Zero);
        if (result != 0)
        {
            string message = Text(sqlite3_errmsg(db));
            Dispose();
            throw new InvalidOperationException(message);
        }
        Execute("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    }

    public List<Dictionary<string, string>> Execute(string sql)
    {
        if (db == IntPtr.Zero) throw new ObjectDisposedException("CongressSQLite");
        var rows = new List<Dictionary<string, string>>();
        Callback callback = delegate(IntPtr context, int count, IntPtr values, IntPtr names) {
            var row = new Dictionary<string, string>();
            for (int i = 0; i < count; i++)
                row.Add(Text(Marshal.ReadIntPtr(names, i * IntPtr.Size)),
                        Text(Marshal.ReadIntPtr(values, i * IntPtr.Size)));
            rows.Add(row);
            return 0;
        };
        IntPtr error;
        int result = sqlite3_exec(db, Utf8(sql), callback, IntPtr.Zero, out error);
        string message = Text(error);
        if (error != IntPtr.Zero) sqlite3_free(error);
        GC.KeepAlive(callback);
        if (result != 0) throw new InvalidOperationException(message);
        return rows;
    }

    public void Dispose()
    {
        if (db != IntPtr.Zero)
        {
            sqlite3_close(db);
            db = IntPtr.Zero;
        }
    }
}
'@
}

function ConvertTo-SqlText($Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return 'NULL' }
    if ([string]$Value -match "\x00") { throw 'El texto contiene un caracter NUL no permitido.' }
    return "'" + ([string]$Value).Replace("'", "''") + "'"
}
