// A plain Xlib app for the Linux video helper's checks (scripts/bench-video-helper.mjs): moving blocks and scrolling
// text at a fixed rate, in a window of the given size; "still" draws once and stops, "red" is a plain red window.
// Prints its window's id.
// cc -O2 -o xanim xanim.c -lX11 ; xanim <fps> <width> <height> [still|red]
#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int fps = argc > 1 ? atoi(argv[1]) : 60;
  Display *d = XOpenDisplay(NULL);
  int s = DefaultScreen(d);
  int W = argc > 2 ? atoi(argv[2]) : DisplayWidth(d, s), H = argc > 3 ? atoi(argv[3]) : DisplayHeight(d, s);
  int still = argc > 4 && !strcmp(argv[4], "still"), red = argc > 4 && !strcmp(argv[4], "red");
  Window w = XCreateSimpleWindow(d, RootWindow(d, s), 0, 0, W, H, 0, 0, red ? 0xff0000 : 0xf5f5f7);
  XMapWindow(d, w);
  XSync(d, False);
  printf("%lu\n", w);
  fflush(stdout);
  if (red) { XClearWindow(d, w); XFlush(d); for (;;) pause(); }
  GC gc = XCreateGC(d, w, 0, 0);
  Pixmap back = XCreatePixmap(d, w, W, H, DefaultDepth(d, s));
  unsigned long colors[6] = {0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2};
  char line[160];
  for (long n = 0;; n++) {
    XSetForeground(d, gc, 0xf5f5f7);
    XFillRectangle(d, back, gc, 0, 0, W, H);
    for (int i = 0; i < 6; i++) {
      XSetForeground(d, gc, colors[i]);
      XFillRectangle(d, back, gc, (n * 7 + i * 300) % W, (i * 220 + n * 3) % H, 260, 160);
    }
    XSetForeground(d, gc, 0x222222);
    for (int y = 0; y < 50; y++) {
      int length = snprintf(line, sizeof line, "%ld  the agent opened the settings page and changed field %ld to something new", n + y, (n * 2 + y) % 997);
      XDrawString(d, back, gc, 24, 24 + y * 15, line, length);
    }
    XCopyArea(d, back, w, gc, 0, 0, W, H, 0, 0);
    XFlush(d);
    if (still) { for (;;) pause(); }
    usleep(1000000 / fps);
  }
}
