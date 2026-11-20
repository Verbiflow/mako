# A window for the Windows video helper's check (scripts/test-video-helper-windows.mjs), as xanim.c is Linux's: it
# prints "hwnd <HWND>" once shown; then, animating, a line "<frame> <ms since 1970>" each time it paints. The frame's
# number is drawn as the color of the 64x64 square at its top left (red the low four bits, green the next four, in
# steps of 16), so a decoded picture says which paint it shows.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-anim.ps1 -Fps 30 -Width 640 -Height 400 [-Mode anim|still|red] [-X 40 -Y 40]
param([int]$Fps = 30, [int]$Width = 640, [int]$Height = 400, [string]$Mode = "anim", [int]$X = 40, [int]$Y = 40)
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Windows.Forms;

public class MakoAnim : Form {
  int frame;
  readonly string mode;
  public MakoAnim(int fps, int width, int height, string mode, int x, int y) {
    this.mode = mode;
    DoubleBuffered = true;
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    Location = new Point(x, y);
    ClientSize = new Size(width, height);
    ShowInTaskbar = false;
    TopMost = mode == "red";
    Text = "mako-anim " + mode;
    Shown += (sender, e) => { Console.WriteLine("hwnd " + Handle.ToInt64()); Console.Out.Flush(); };
    if (mode == "anim") {
      var timer = new Timer { Interval = Math.Max(1, 1000 / fps) };
      timer.Tick += (sender, e) => { frame++; Invalidate(); };
      timer.Start();
    }
  }
  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    if (mode == "red") { g.Clear(Color.FromArgb(255, 0, 0)); return; }
    g.Clear(Color.FromArgb(30, 30, 40));
    int span = Math.Max(1, ClientSize.Width - 160);
    g.FillRectangle(Brushes.Orange, 80 + (frame * 9) % span, 120, 80, 80);
    using (var marker = new SolidBrush(Color.FromArgb((frame % 16) * 16 + 8, ((frame / 16) % 16) * 16 + 8, 128)))
      g.FillRectangle(marker, 0, 0, 64, 64);
    using (var font = new Font("Segoe UI", 14))
      g.DrawString("Mako video " + frame, font, Brushes.White, 80, 20);
    if (mode == "anim") { Console.WriteLine(frame + " " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); Console.Out.Flush(); }
  }
}
"@
[System.Windows.Forms.Application]::Run((New-Object MakoAnim $Fps, $Width, $Height, $Mode, $X, $Y))
