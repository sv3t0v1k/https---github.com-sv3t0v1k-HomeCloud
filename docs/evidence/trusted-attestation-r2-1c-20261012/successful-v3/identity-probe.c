#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Research only. Never resolves a handle, writes storage, or mounts anything. */
static void handle(int fd, const char *label, const char *name, int flags) {
  struct file_handle *h = calloc(1, sizeof(*h) + 128);
  if (!h) exit(2);
  h->handle_bytes = 128;
  int mount_id = -1;
  errno = 0;
  int rc = name_to_handle_at(fd, name, h, &mount_id, flags);
  int err = rc < 0 ? errno : 0;
  printf("\"%s\":{\"rc\":%d,\"errno\":%d,\"bytes\":%u,\"type\":%d,\"mount_id\":%d,\"hex\":\"",
         label, rc, err, h->handle_bytes, h->handle_type, mount_id);
  if (!err) for (unsigned i = 0; i < h->handle_bytes; i++) printf("%02x", h->f_handle[i]);
  printf("\"}");
  free(h);
}
int main(int argc, char **argv) {
  if (argc < 2 || argc > 3 || (argv[1][0] != '/' && strcmp(argv[1], "@fd3"))) return 2;
  int fd = -1, err = 0;
  if (!strcmp(argv[1], "@fd3")) {
    fd = dup(3); err=errno; /* inherited pinned O_RDONLY FD, never reopen pathname */
  } else {
    int ancestor = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (ancestor < 0) return 2;
    struct open_how how = {.flags=O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC,
      .resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS};
    fd = syscall(SYS_openat2, ancestor, argv[1][1] ? argv[1]+1 : ".", &how, sizeof(how));
    err=errno; close(ancestor);
  }
  if (fd < 0) { printf("{\"root_open_errno\":%d}\n",err); return 1; }
  if (argc == 3) {
    struct open_how how = {.flags=O_RDONLY|O_NOFOLLOW|O_CLOEXEC,
      .resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
    int child = syscall(SYS_openat2,fd,argv[2],&how,sizeof(how));
    err=errno; close(fd);
    if(child<0) { printf("{\"child_open_errno\":%d}\n",err); return 1; }
    fd=child;
    /* Only a caller-selected disposable marker is read, never XFS user data. */
    char buf[128]; ssize_t n=read(fd,buf,sizeof(buf));
    if(n<0){close(fd);return 1;}
    printf("{\"hex\":\"");for(ssize_t i=0;i<n;i++)printf("%02x",(unsigned char)buf[i]);
    printf("\"}\n");close(fd);return 0;
  }
  struct stat st;
  struct statfs sf;
  if(fstat(fd,&st)<0 || fstatfs(fd,&sf)<0) return 2;
  struct statx sx={0}, unique={0};
  int sr=statx(fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,STATX_BASIC_STATS|STATX_MNT_ID,&sx);
  int ur=statx(fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,0x4000U,&unique);
  printf("{\"uid\":%u,\"pid\":%d,\"dev\":%llu,\"ino\":%llu,\"owner\":%u,\"mode\":%u,\"fs_type\":%llu,\"fsid\":\"%08x%08x\",\"statx_rc\":%d,\"mount_id\":%llu,\"unique_rc\":%d,\"unique_supported\":%s,\"unique_id\":%llu,",
    getuid(),getpid(),(unsigned long long)st.st_dev,(unsigned long long)st.st_ino,
    st.st_uid,st.st_mode,(unsigned long long)sf.f_type,
    (unsigned)sf.f_fsid.__val[0],(unsigned)sf.f_fsid.__val[1],sr,
    (unsigned long long)sx.stx_mnt_id,ur,(unique.stx_mask&0x4000U)?"true":"false",
    (unsigned long long)unique.stx_mnt_id);
  handle(fd,"empty","",AT_EMPTY_PATH);
  if (S_ISDIR(st.st_mode)) { printf(","); handle(fd,"dot",".",0); }
  printf(",\"process_security\":{");
  FILE *status=fopen("/proc/self/status","r");
  char line[256], key[64], value[128];
  int count=0;
  if(status) {
    while(fgets(line,sizeof(line),status)) {
      if(sscanf(line,"%63[^:]: %127s",key,value)==2 &&
         (!strncmp(key,"Cap",3)||!strcmp(key,"NoNewPrivs")||!strcmp(key,"Seccomp"))) {
        printf("%s\"%s\":\"%s\"",count++?",":"",key,value);
      }
    }
    fclose(status);
  }
  printf("}}\n");
  close(fd);
  return 0;
}
