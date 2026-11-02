// Pluck for Mac: the app's own executable. Made by Matte Black.
//
// Starts Resources/launch.sh in the background and returns straight away, so macOS never sees
// Pluck as "already running". Every click on the icon runs this again, and a running Pluck
// simply brings its window back.

#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

static int self_path(char *out, size_t size) {
#ifdef __APPLE__
  char raw[PATH_MAX];
  uint32_t n = sizeof raw;
  if (_NSGetExecutablePath(raw, &n) != 0) return -1;
  return realpath(raw, out) ? 0 : -1;
#else
  ssize_t n = readlink("/proc/self/exe", out, size - 1);
  if (n < 0) return -1;
  out[n] = 0;
  return 0;
#endif
}

int main(void) {
  char exe[PATH_MAX], script[PATH_MAX + 32];
  if (self_path(exe, sizeof exe) != 0) return 1;
  char *slash = strrchr(exe, '/');
  if (!slash) return 1;
  *slash = 0; /* .../Pluck.app/Contents/MacOS */
  if (snprintf(script, sizeof script, "%s/../Resources/launch.sh", exe) >= (int)sizeof script) return 1;

  pid_t pid = fork();
  if (pid > 0) return 0;
  if (pid == 0) {
    setsid();
    int fd = open("/dev/null", O_RDWR);
    if (fd >= 0) { dup2(fd, 0); dup2(fd, 1); dup2(fd, 2); if (fd > 2) close(fd); }
  }
  execl("/bin/bash", "bash", script, (char *)NULL);
  _exit(1);
}
