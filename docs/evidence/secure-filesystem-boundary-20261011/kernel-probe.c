#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef STATX_MNT_ID_UNIQUE
#define STATX_MNT_ID_UNIQUE 0x00004000U
#endif

/* Qualification executable only. Not loaded by HomeCloud, not a runtime adapter. */
static void check(int ok, const char *what) {
  if (!ok) { perror(what); exit(1); }
}
static int safe_open(int root, const char *key, int flags) {
  struct open_how how = {
    .flags = (unsigned long long)(flags | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK),
    .mode = (flags & O_CREAT) ? 0600 : 0,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
               RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
  };
  return (int)syscall(SYS_openat2, root, key, &how, sizeof(how));
}
static void denied(int root, const char *key, int expected) {
  int fd = safe_open(root, key, O_WRONLY | O_CREAT | O_EXCL);
  if (fd >= 0) close(fd);
  check(fd < 0 && errno == expected, key);
}
static void write_fixture(int fd) {
  const unsigned char bytes[] = {0, 255, 128, 0, 1};
  struct stat st;
  check(fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1,
        "regular exclusive file");
  check(write(fd, bytes, sizeof(bytes)) == (ssize_t)sizeof(bytes), "write");
  check(fsync(fd) == 0, "fsync file");
}
static int rename_excl(int a, const char *src, int b, const char *dst) {
  return (int)syscall(SYS_renameat2, a, src, b, dst, RENAME_NOREPLACE);
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--observe-cwd-unique-id") == 0) {
    FILE *map = fopen("/proc/self/uid_map", "r");
    unsigned int inside, host, length;
    check(map && fscanf(map, "%u %u %u", &inside, &host, &length) == 3 &&
          inside == 0 && host == 1001 && length == 1 && getuid() == 0,
          "private uid0-to-host1001 namespace only");
    fclose(map);
    int observed = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct statx unique;
    memset(&unique, 0, sizeof(unique));
    check(observed >= 0 && syscall(SYS_statx, observed, "",
          AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_MNT_ID_UNIQUE, &unique) == 0 &&
          (unique.stx_mask & STATX_MNT_ID_UNIQUE), "observed unique mount ID");
    close(observed);
    printf("{\"uniqueMountId\":%llu}\n", (unsigned long long)unique.stx_mnt_id);
    return 0;
  }
  check(argc == 1, "no arbitrary arguments");
  check(getuid() == 1001 && geteuid() == 1001, "non-root uid1001 required");
  check(access("/storage", F_OK) < 0 && errno == ENOENT, "no canonical storage");
  char scratch[] = "/tmp/hc-ms3br-kernel-XXXXXX";
  check(mkdtemp(scratch) != NULL, "private scratch");
  int outside = open(scratch, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  int root = open("/qualified", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  check(root >= 0 && outside >= 0, "isolated roots");
  struct statfs filesystem;
  check(fstatfs(root, &filesystem) == 0 && filesystem.f_type == TMPFS_MAGIC,
        "qualification root must be tmpfs");
  DIR *entries = fdopendir(dup(root));
  check(entries != NULL, "fixture root inventory");
  struct dirent *entry; int nested = 0;
  while ((entry = readdir(entries)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    check(strcmp(entry->d_name, "nested") == 0, "refuse non-empty fixture root");
    nested++;
  }
  closedir(entries); check(nested == 1, "isolated nested mount fixture required");
  struct statx identity;
  memset(&identity, 0, sizeof(identity));
  check(syscall(SYS_statx, root, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
                STATX_INO | STATX_MNT_ID, &identity) == 0 &&
        (identity.stx_mask & STATX_MNT_ID), "FD statx mount identity");
  struct statx unique;
  memset(&unique, 0, sizeof(unique));
  check(syscall(SYS_statx, root, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
                STATX_MNT_ID_UNIQUE, &unique) == 0 &&
        (unique.stx_mask & STATX_MNT_ID_UNIQUE), "FD statx unique mount ID");
  check(mkdirat(root, "ingress", 0700) == 0, "mkdir ingress");
  check(mkdirat(root, "session", 0700) == 0, "mkdir session");
  int ingress = safe_open(root, "ingress", O_RDONLY | O_DIRECTORY);
  int session = safe_open(root, "session", O_RDONLY | O_DIRECTORY);
  check(ingress >= 0 && session >= 0, "openat2 available under current seccomp");
  denied(root, "../escape", EXDEV);
  denied(root, "/tmp/escape", EXDEV);
  check(symlinkat(scratch, root, "static-link") == 0, "symlink fixture");
  denied(root, "static-link/escape", ELOOP);
  check(symlinkat("/proc/self/fd/0", root, "magic-link") == 0, "magic fixture");
  denied(root, "magic-link", EEXIST); /* exclusive leaf create refuses existing link */
  errno = 0;
  int magic = safe_open(root, "magic-link", O_RDONLY);
  check(magic < 0 && errno == ELOOP, "magic link read denied");
  denied(root, "nested/escape", EXDEV); /* actual second Docker-created tmpfs */

  /* Swap after parent FD capture. Fresh traversal fails; captured object is used. */
  check(renameat(root, "ingress", root, "saved-ingress") == 0, "swap ingress");
  check(symlinkat(scratch, root, "ingress") == 0, "swapped ancestor");
  denied(root, "ingress/escape", ELOOP);
  int fd = safe_open(ingress, "fixture", O_WRONLY | O_CREAT | O_EXCL);
  check(fd >= 0, "create under retained parent");
  write_fixture(fd); close(fd);
  check(renameat(root, "session", root, "saved-session") == 0, "swap session");
  check(symlinkat(scratch, root, "session") == 0, "swapped destination ancestor");
  check(rename_excl(ingress, "fixture", session, "chunk") == 0, "FD rename adoption");
  check(fsync(ingress) == 0 && fsync(session) == 0, "sync rename parents");
  fd = safe_open(session, "chunk", O_RDONLY);
  unsigned char buffer[5];
  const unsigned char expected[] = {0, 255, 128, 0, 1};
  check(fd >= 0 && read(fd, buffer, sizeof(buffer)) == 5 &&
        memcmp(buffer, expected, sizeof(buffer)) == 0, "FD chunk read exact bytes");
  close(fd);
  check(unlinkat(session, "chunk", 0) == 0, "FD cleanup under swapped ancestor");
  check(unlinkat(root, "ingress", 0) == 0 && unlinkat(root, "session", 0) == 0,
        "restore swapped names");
  check(renameat(root, "saved-ingress", root, "ingress") == 0 &&
        renameat(root, "saved-session", root, "session") == 0, "restore parents");

  fd = safe_open(ingress, "source", O_WRONLY | O_CREAT | O_EXCL);
  check(fd >= 0, "EXDEV source"); write_fixture(fd); close(fd);
  check(rename_excl(ingress, "source", outside, "escape") < 0 && errno == EXDEV,
        "EXDEV without copying");
  struct stat st;
  check(fstatat(ingress, "source", &st, AT_SYMLINK_NOFOLLOW) == 0 && st.st_size == 5,
        "EXDEV source preserved");
  check(unlinkat(ingress, "source", 0) == 0, "source cleanup");

  int barrier[2]; check(pipe2(barrier, O_CLOEXEC) == 0, "barrier");
  pid_t attacker = fork(); check(attacker >= 0, "fork attacker");
  if (attacker == 0) {
    close(barrier[0]);
    check(renameat(root, "ingress", root, "saved-ingress") == 0, "race hide");
    check(symlinkat(scratch, root, "ingress") == 0, "race symlink");
    check(write(barrier[1], "x", 1) == 1, "race ready");
    for (int i = 0; i < 3000; i++) {
      check(unlinkat(root, "ingress", 0) == 0, "race unlink");
      check(renameat(root, "saved-ingress", root, "ingress") == 0, "race restore");
      check(renameat(root, "ingress", root, "saved-ingress") == 0, "race hide");
      check(symlinkat(scratch, root, "ingress") == 0, "race symlink");
    }
    check(unlinkat(root, "ingress", 0) == 0, "final race unlink");
    check(renameat(root, "saved-ingress", root, "ingress") == 0, "final race restore");
    close(barrier[1]); _exit(0);
  }
  close(barrier[1]); char ready;
  check(read(barrier[0], &ready, 1) == 1, "attacker active"); close(barrier[0]);
  int successes = 0, rejections = 0;
  for (int i = 0; i < 2000; i++) {
    fd = safe_open(root, "ingress/race-file", O_WRONLY | O_CREAT | O_EXCL);
    if (fd >= 0) {
      write_fixture(fd); close(fd); successes++;
      check(unlinkat(ingress, "race-file", 0) == 0, "FD race cleanup");
    } else {
      check(errno == ELOOP || errno == ENOENT || errno == EAGAIN,
            "only explicit race refusals"); rejections++;
    }
  }
  int status;
  check(waitpid(attacker, &status, 0) == attacker && WIFEXITED(status) &&
        WEXITSTATUS(status) == 0, "attacker complete");
  check(successes + rejections == 2000, "all race attempts accounted");
  check(fstatat(outside, "escape", &st, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT,
        "no escaped traversal/create/rename");
  check(fstatat(outside, "race-file", &st, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT,
        "no escaped concurrent writes");
  check(unlinkat(root, "static-link", 0) == 0 && unlinkat(root, "magic-link", 0) == 0,
        "fixture links cleanup");
  close(ingress); close(session);
  check(unlinkat(root, "ingress", AT_REMOVEDIR) == 0 &&
        unlinkat(root, "session", AT_REMOVEDIR) == 0, "fixture dirs cleanup");
  close(root); close(outside); check(rmdir(scratch) == 0, "empty outside scratch removed");
  printf("{\"scope\":\"kernel-only, NOT production adapter\",\"uid\":1001,"
         "\"openat2\":\"PASS\",\"fdStatxMountId\":%llu,\"fdUniqueMountId\":%llu,"
         "\"traversalAndSymlink\":\"PASS\",\"actualNestedMountNoXdev\":\"PASS\","
         "\"pinnedParentCreateReadRenameUnlink\":\"PASS\",\"actualExdev\":\"PASS\","
         "\"concurrentAttempts\":2000,\"concurrentSuccesses\":%d,\"concurrentRefusals\":%d,"
         "\"outsideBytes\":0,\"scratchCleanup\":\"PASS\","
         "\"applicationSecureOpen\":false,\"activation\":\"disabled\"}\n",
         (unsigned long long)identity.stx_mnt_id, (unsigned long long)unique.stx_mnt_id, successes, rejections);
  return 0;
}
