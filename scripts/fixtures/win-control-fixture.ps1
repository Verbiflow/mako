# A Windows Forms window for the Windows computer-control checks (scripts/test-control-driver-windows.ts). Everything
# it receives is written to a JSON state file, so a check reads what the window got rather than what the driver says:
# the text field's value, button presses, the check box, the list's scroll position, every mouse press, move and release
# on the canvas in client pixels, and every key that reached the window.
#
#   powershell -File win-control-fixture.ps1 -Title "Mako control fixture" -State C:\...\state.json [-Activate]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$State,
  [switch]$Activate
)
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// The canvas logs the mouse messages its window procedure receives, as Windows delivered them: a posted message
// carries no button state for WinForms' own events to read, so the messages are the evidence.
public class Canvas : Panel {
  public Action<string> Log;
  protected override void WndProc(ref Message m) {
    string kind = null;
    switch (m.Msg) {
      case 0x0200: kind = ((m.WParam.ToInt64() & 1) != 0) ? "move:Left" : null; break;
      case 0x0201: kind = "down:Left"; break;
      case 0x0202: kind = "up:Left"; break;
      case 0x0203: kind = "double:Left"; break;
      case 0x0204: kind = "down:Right"; break;
      case 0x0205: kind = "up:Right"; break;
      case 0x020A: kind = "wheel:" + ((short)((m.WParam.ToInt64() >> 16) & 0xFFFF)); break;
    }
    if (kind != null && Log != null) {
      long l = m.LParam.ToInt64();
      int x = (short)(l & 0xFFFF), y = (short)((l >> 16) & 0xFFFF);
      if (m.Msg == 0x020A) { var p = PointToClient(new Point(x, y)); x = p.X; y = p.Y; }
      Log(kind + ":" + (x + Left) + "," + (y + Top));
    }
    base.WndProc(ref m);
  }
}

public class MakoFixture : Form {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  readonly string state;
  readonly bool activate;
  readonly TextBox proof = new TextBox();
  readonly CheckBox check = new CheckBox();
  readonly ListBox list = new ListBox();
  readonly Canvas canvas = new Canvas();
  string verified = "";
  int presses;
  readonly List<string> mouse = new List<string>();
  readonly List<string> keys = new List<string>();
  readonly StringBuilder typed = new StringBuilder();

  public static void Run(string title, string state, bool activate) {
    // Per-monitor v2, as the driver is: pixels in the state file are the window's own physical pixels.
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    Application.EnableVisualStyles();
    // An exception in a handler is written beside the state for the check to read, not shown in a dialog that would
    // take the window's place in every later read.
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
    Application.ThreadException += (s, e) => File.AppendAllText(state + ".errors", e.Exception + Environment.NewLine);
    Application.Run(new MakoFixture(title, state, activate));
  }

  MakoFixture(string title, string state, bool activate) {
    this.state = state;
    this.activate = activate;
    Text = title;
    AccessibleName = title;
    StartPosition = FormStartPosition.Manual;
    Location = new Point(120, 120);
    ClientSize = new Size(640, 480);
    KeyPreview = true;
    var label = new Label { Text = "Proof", Location = new Point(16, 18), AutoSize = true };
    proof.Location = new Point(80, 14);
    proof.Width = 300;
    proof.Name = "proof";
    proof.AccessibleName = "Proof";
    proof.TextChanged += (s, e) => Save();
    var button = new Button { Text = "Verify proof", Location = new Point(400, 12), Width = 120, Name = "verify" };
    button.Click += (s, e) => { presses++; verified = proof.Text; Save(); };
    check.Text = "Enabled";
    check.Location = new Point(16, 52);
    check.AccessibleName = "Enabled";
    check.CheckedChanged += (s, e) => Save();
    list.Location = new Point(16, 84);
    list.Size = new Size(200, 180);
    list.AccessibleName = "Items";
    for (int i = 0; i < 200; i++) list.Items.Add("Item " + i);
    list.SelectedIndexChanged += (s, e) => Save();
    // A list scrolled by a wheel message or by UI Automation raises no event of its own: its top row is watched.
    var lastTop = 0;
    var watch = new Timer { Interval = 50 };
    watch.Tick += (s, e) => { if (list.TopIndex != lastTop) { lastTop = list.TopIndex; Save(); } };
    watch.Start();
    canvas.Location = new Point(240, 84);
    canvas.Size = new Size(380, 380);
    canvas.BackColor = Color.FromArgb(40, 120, 200);
    canvas.AccessibleName = "Canvas";
    canvas.Log = (line) => { mouse.Add(line); Save(); };
    KeyDown += (s, e) => { keys.Add("down:" + e.KeyCode + (e.Control ? "+ctrl" : "") + (e.Shift ? "+shift" : "") + (e.Alt ? "+alt" : "")); Save(); };
    KeyPress += (s, e) => { typed.Append(e.KeyChar); Save(); };
    Controls.AddRange(new Control[] { label, proof, button, check, list, canvas });
    Shown += (s, e) => Save();
    Activated += (s, e) => Save();
    Deactivate += (s, e) => Save();
  }

  // Shown behind the window the person is in unless asked otherwise: the checks drive a background window.
  protected override bool ShowWithoutActivation { get { return !activate; } }

  static string Quote(string value) {
    var b = new StringBuilder("\"");
    foreach (char c in value) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      // Everything past ASCII is escaped: a surrogate pair arrives one half per key event, and a lone half has no
      // UTF-8 form to write.
      else if (c < ' ' || c > '~') b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string List(List<string> items) {
    var parts = new List<string>();
    foreach (var item in items) parts.Add(Quote(item));
    return "[" + string.Join(",", parts) + "]";
  }

  void Save() {
    var json = "{"
      + "\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id
      + ",\"hwnd\":" + Handle.ToInt64()
      + ",\"dpi\":" + GetDpiForWindow(Handle)
      + ",\"active\":" + (Form.ActiveForm == this ? "true" : "false")
      + ",\"input\":" + Quote(proof.Text)
      + ",\"verified\":" + Quote(verified)
      + ",\"presses\":" + presses
      + ",\"checked\":" + (check.Checked ? "true" : "false")
      + ",\"topIndex\":" + list.TopIndex
      + ",\"selected\":" + list.SelectedIndex
      + ",\"client\":{\"left\":" + PointToScreen(Point.Empty).X + ",\"top\":" + PointToScreen(Point.Empty).Y + "}"
      + ",\"mouse\":" + List(mouse)
      + ",\"keys\":" + List(keys)
      + ",\"typed\":" + Quote(typed.ToString())
      + "}";
    // The check reads the file while this replaces it: a replace that finds it open waits a moment and tries again,
    // and one that still can't leaves it to the next event, which writes the whole state again.
    var temporary = state + ".tmp";
    for (int attempt = 0; attempt < 20; attempt++) {
      try {
        File.WriteAllText(temporary, json);
        if (File.Exists(state)) File.Replace(temporary, state, null);
        else File.Move(temporary, state);
        return;
      } catch (IOException) {
        System.Threading.Thread.Sleep(5);
      } catch (UnauthorizedAccessException) {
        System.Threading.Thread.Sleep(5);
      }
    }
  }
}
"@
[MakoFixture]::Run($Title, $State, [bool]$Activate)
