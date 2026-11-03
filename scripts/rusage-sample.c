#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

/* CPU time, disk bytes and memory of each pid, as JSON: what the footprint bench reads of processes it started. */
int main(int argc, char **argv) {
  if (argc < 2 || argc > 129) return 2;
  mach_timebase_info_data_t base;
  mach_timebase_info(&base);
  printf("[");
  for (int i = 1; i < argc; i++) {
    char *end;
    errno = 0;
    long pid = strtol(argv[i], &end, 10);
    if (errno || *end || pid < 1 || pid > 2147483647) return 2;
    struct rusage_info_v4 info = {0};
    int result = proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&info);
    if (i > 1) printf(",");
    if (result != 0) {
      printf("{\"pid\":%ld,\"error\":%d}", pid, errno);
      continue;
    }
    /* Times are in mach ticks, nanoseconds only on Intel. */
    unsigned long long cpu = (info.ri_user_time + info.ri_system_time) * base.numer / base.denom;
    printf("{\"pid\":%ld,\"cpuNs\":%llu,\"diskReadBytes\":%llu,\"diskWriteBytes\":%llu,\"physicalFootprintBytes\":%llu,\"peakPhysicalFootprintBytes\":%llu}",
      pid, cpu,
      (unsigned long long)info.ri_diskio_bytesread,
      (unsigned long long)info.ri_diskio_byteswritten,
      (unsigned long long)info.ri_phys_footprint,
      (unsigned long long)info.ri_lifetime_max_phys_footprint);
  }
  printf("]\n");
  return 0;
}
