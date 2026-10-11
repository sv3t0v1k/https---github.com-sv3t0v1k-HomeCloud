#define _GNU_SOURCE
#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <stddef.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <linux/openat2.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <stdlib.h>
static long raw4(long n,long a,long b,long c,long d) {
#if defined(__x86_64__)
 register long r10 __asm__("r10")=d; long out;
 __asm__ volatile("syscall":"=a"(out):"a"(n),"D"(a),"S"(b),"d"(c),"r"(r10):"rcx","r11","memory");return out;
#elif defined(__aarch64__)
 register long x8 __asm__("x8")=n;register long x0 __asm__("x0")=a;
 register long x1 __asm__("x1")=b;register long x2 __asm__("x2")=c;register long x3 __asm__("x3")=d;
 __asm__ volatile("svc #0":"+r"(x0):"r"(x8),"r"(x1),"r"(x2),"r"(x3):"memory");return x0;
#else
#error Unsupported architecture
#endif
}
static void test(int fd,const char* label,struct open_how* how,size_t size) {
 errno=0;long r=syscall(SYS_openat2,fd,".",how,size);int err=r<0?errno:0;
 printf("libc %s result=%ld errno=%d (%s)\n",label,r,err,strerror(err));if(r>=0)close((int)r);
 r=raw4(SYS_openat2,fd,(long)".",(long)how,size);err=r<0?(int)-r:0;
 printf("raw %s result=%ld errno=%d (%s)\n",label,r,err,strerror(err));if(r>=0)close((int)r);
}
int main(int argc,char** argv) {
 if(getuid()!=1000 && getuid()!=1001){fprintf(stderr,"Require non-root uid1000 or1001\n");return 2;}
 struct utsname u;uname(&u);
#if defined(__x86_64__)
 const char* compiled="x86_64";
#else
 const char* compiled="aarch64";
#endif
 printf("compiled=%s uname=%s %s %s uid=%d SYS_openat2=%d SYS_renameat2=%d how_size=%zu offsets=%zu,%zu,%zu\n",compiled,u.sysname,u.release,u.machine,getuid(),SYS_openat2,SYS_renameat2,sizeof(struct open_how),offsetof(struct open_how,flags),offsetof(struct open_how,mode),offsetof(struct open_how,resolve));
 FILE* f=fopen("/proc/self/status","r");if(f){char line[4096];while(fgets(line,sizeof(line),f))if(!strncmp(line,"Seccomp",7)||!strncmp(line,"Cap",3)||!strncmp(line,"NoNewPrivs",10))fputs(line,stdout);fclose(f);}
 char buf[4096];ssize_t len=readlink("/proc/self/exe",buf,sizeof(buf)-1);if(len>=0){buf[len]=0;printf("self_exe=%s\n",buf);}
 f=fopen("/proc/self/maps","r");if(f){while(fgets(buf,sizeof(buf),f))if(strstr(buf,"qemu")||strstr(buf,"rosetta"))fputs(buf,stdout);fclose(f);}
 // Optional restrictive sentinel: additional process-only filter denies openat2 with EACCES.
 if(argc>1 && (!strcmp(argv[1],"deny-openat2") || !strcmp(argv[1],"deny-exec-amd64"))) {
  struct sock_filter ins[]={BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_openat2,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EACCES),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
  struct sock_fprog prog={.len=4,.filter=ins};errno=0;int a=prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0);int b=a<0?-1:prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&prog);printf("restrictive_filter rc=%d errno=%d\n",b,b<0?errno:0);
  if(b<0)return 3;
  if(!strcmp(argv[1],"deny-exec-amd64")){fflush(stdout);execl("/evidence/probe-amd64","probe-amd64",(char*)NULL);perror("exec");return 4;}
 }
 int fd=open(getenv("HC_PROBE_ROOT") ? getenv("HC_PROBE_ROOT") : "/qualified",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(fd<0){perror("fixture");return 2;}
 struct open_how how={.flags=O_RDONLY|O_DIRECTORY|O_CLOEXEC,.resolve=0};test(fd,"valid-no-resolve",&how,sizeof(how));
 how.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV;test(fd,"full-resolve",&how,sizeof(how));test(fd,"zero-size",&how,0);test(fd,"bad-pointer",NULL,sizeof(how));
 errno=0;long r=syscall(SYS_renameat2,fd,"missing-source",fd,"missing-target",1);printf("renameat2 result=%ld errno=%d\n",r,r<0?errno:0);
 close(fd);return 0;
}
