#define _GNU_SOURCE
#include <node_api.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <linux/openat2.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

typedef struct { int fd; } root_cap;
static napi_value fail(napi_env e) {
  int err=errno; napi_value msg,code,obj;
  const char *name=err==ENOENT?"ENOENT":err==ENOTDIR?"ENOTDIR":err==EXDEV?"EXDEV":err==EEXIST?"EEXIST":err==ELOOP?"ELOOP":err==ENOSYS?"ENOSYS":err==EPERM?"EPERM":err==EWOULDBLOCK?"EWOULDBLOCK":"ESECUREFS";
  napi_create_string_utf8(e,strerror(err),NAPI_AUTO_LENGTH,&msg);
  napi_create_string_utf8(e,name,NAPI_AUTO_LENGTH,&code);
  napi_create_error(e,code,msg,&obj); napi_throw(e,obj); return NULL;
}
static int text_arg(napi_env e,napi_value v,char *s,size_t cap) {
  size_t len=0,written=0; napi_valuetype t;
  if(napi_typeof(e,v,&t)!=napi_ok || t!=napi_string || napi_get_value_string_utf8(e,v,NULL,0,&len)!=napi_ok || len==0 || len>=cap) { errno=EINVAL; return -1; }
  napi_get_value_string_utf8(e,v,s,cap,&written);
  if(written!=len || strlen(s)!=len) {errno=EINVAL;return -1;} return 0;
}
static int key_ok(const char *s) {
  if(s[0]=='/') return 0;
  const char *p=s;
  while(*p) { const char *q=strchr(p,'/'); size_t n=q?(size_t)(q-p):strlen(p);
    if(n==0 || (n==1 && *p=='.') || (n==2 && p[0]=='.' && p[1]=='.')) return 0;
    if(!q) return 1; p=q+1; if(!*p) return 0;
  } return 0;
}
static int safe_open(int fd,const char *s,int flags) {
  struct open_how how={.flags=(unsigned long long)(flags|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK),.mode=(flags&O_CREAT)?0600:0,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
  return (int)syscall(SYS_openat2,fd,s,&how,sizeof(how));
}
static int owned(int fd,int directory) { struct stat st; if(fstat(fd,&st)<0)return -1;
  if((directory?!S_ISDIR(st.st_mode):!S_ISREG(st.st_mode)) || st.st_uid!=geteuid() || (!directory && st.st_nlink!=1)) {errno=EPERM;return -1;} return 0; }
static void finalize(napi_env e,void *data,void *hint) { (void)e;(void)hint;root_cap *c=data;if(c->fd>=0)close(c->fd);free(c); }
static napi_value number(napi_env e,int n) {napi_value v;napi_create_int32(e,n,&v);return v;}
static napi_value nothing(napi_env e) {napi_value v;napi_get_undefined(e,&v);return v;}
static root_cap *args(napi_env e,napi_callback_info info,napi_value *v,size_t n) { size_t count=n;root_cap *c=NULL;
  if(napi_get_cb_info(e,info,&count,v,NULL,NULL)!=napi_ok || count!=n || napi_get_value_external(e,v[0],(void**)&c)!=napi_ok || !c || c->fd<0) {errno=EBADF;return NULL;}return c;}
static napi_value root(napi_env e,napi_callback_info info) {
  napi_value v;size_t n=1;char s[4096];napi_get_cb_info(e,info,&n,&v,NULL,NULL);
  if(n!=1 || text_arg(e,v,s,sizeof(s))<0 || s[0]!='/' || !key_ok(s+1)) {errno=EINVAL;return fail(e);}
  int ancestor=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(ancestor<0)return fail(e);
  struct open_how how={.flags=O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS};
  int fd=(int)syscall(SYS_openat2,ancestor,s+1,&how,sizeof(how));int err=errno;close(ancestor);errno=err;
  if(fd<0)return fail(e);if(owned(fd,1)<0){err=errno;close(fd);errno=err;return fail(e);}
  int probe=safe_open(fd,".",O_RDONLY|O_DIRECTORY);if(probe<0){err=errno;close(fd);errno=err;return fail(e);}close(probe);
  root_cap *c=calloc(1,sizeof(*c));if(!c){close(fd);errno=ENOMEM;return fail(e);}c->fd=fd;
  if(napi_create_external(e,c,finalize,NULL,&v)!=napi_ok){close(fd);free(c);errno=ENOMEM;return fail(e);}return v;
}
static int parent(int rootfd,char *s,char **leaf) {
  char *slash=strrchr(s,'/');if(!slash){*leaf=s;return safe_open(rootfd,".",O_RDONLY|O_DIRECTORY);}
  *slash=0;*leaf=slash+1;return safe_open(rootfd,s,O_RDONLY|O_DIRECTORY);
}
static napi_value open_file(napi_env e,napi_callback_info info) {
  napi_value v[3];root_cap *c=args(e,info,v,3);char s[4096],mode[16];if(!c)return fail(e);
  if(text_arg(e,v[1],s,sizeof(s))<0 || !key_ok(s) || text_arg(e,v[2],mode,sizeof(mode))<0){errno=EINVAL;return fail(e);}
  int flags=!strcmp(mode,"r")?O_RDONLY:!strcmp(mode,"rw")?O_RDWR:!strcmp(mode,"wx")?(O_WRONLY|O_CREAT|O_EXCL):-1;
  if(flags<0){errno=EINVAL;return fail(e);}int fd=safe_open(c->fd,s,flags);if(fd<0)return fail(e);
  if(owned(fd,0)<0){int err=errno;close(fd);errno=err;return fail(e);}return number(e,fd);
}
static napi_value dir(napi_env e,napi_callback_info info) {
 napi_value v[2];root_cap *c=args(e,info,v,2);char s[4096];if(!c)return fail(e);
 if(text_arg(e,v[1],s,sizeof(s))<0 || (strcmp(s,".") && !key_ok(s))){errno=EINVAL;return fail(e);}
 int fd=safe_open(c->fd,s,O_RDONLY|O_DIRECTORY);if(fd<0)return fail(e);if(owned(fd,1)<0){int err=errno;close(fd);errno=err;return fail(e);}return number(e,fd);
}
static napi_value mkdir_key(napi_env e,napi_callback_info info) {
 napi_value v[2];root_cap *c=args(e,info,v,2);char s[4096],*leaf;if(!c)return fail(e);
 if(text_arg(e,v[1],s,sizeof(s))<0 || !key_ok(s)){errno=EINVAL;return fail(e);}int fd=parent(c->fd,s,&leaf);if(fd<0)return fail(e);
 int rc=mkdirat(fd,leaf,0700);if(rc<0 && errno!=EEXIST){int err=errno;close(fd);errno=err;return fail(e);}
 int child=safe_open(fd,leaf,O_RDONLY|O_DIRECTORY);if(child<0){int err=errno;close(fd);errno=err;return fail(e);}
 rc=owned(child,1);int err=errno;close(child);if(rc==0)rc=fsync(fd);if(rc<0)err=errno;close(fd);errno=err;return rc<0?fail(e):nothing(e);
}
static napi_value rename_key(napi_env e,napi_callback_info info) {
 napi_value v[3];root_cap *c=args(e,info,v,3);char a[4096],b[4096],*al,*bl;if(!c)return fail(e);
 if(text_arg(e,v[1],a,sizeof(a))<0 || !key_ok(a) || text_arg(e,v[2],b,sizeof(b))<0 || !key_ok(b)){errno=EINVAL;return fail(e);}
 int af=parent(c->fd,a,&al);if(af<0)return fail(e);int bf=parent(c->fd,b,&bl);if(bf<0){int err=errno;close(af);errno=err;return fail(e);}
 int rc=(int)syscall(SYS_renameat2,af,al,bf,bl,1 /* RENAME_NOREPLACE */);int err=errno;
 if(rc==0){rc=fsync(af);if(rc==0)rc=fsync(bf);err=errno;}close(af);close(bf);errno=err;return rc<0?fail(e):nothing(e);
}
static int remove_at(int p,const char *name,int recursive,unsigned depth) {
 if(depth>64){errno=ELOOP;return -1;}
 if(!recursive)return unlinkat(p,name,0);
 int fd=safe_open(p,name,O_RDONLY|O_DIRECTORY);
 if(fd<0){if(errno==ENOTDIR || errno==ELOOP)return unlinkat(p,name,0);return -1;}
 if(owned(fd,1)<0){int err=errno;close(fd);errno=err;return -1;}
 DIR *d=fdopendir(fd);if(!d){int err=errno;close(fd);errno=err;return -1;}
 int rc=0;struct dirent *ent;errno=0;
 while((ent=readdir(d))){if(!strcmp(ent->d_name,".") || !strcmp(ent->d_name,".."))continue;
   if(remove_at(fd,ent->d_name,1,depth+1)<0 && errno!=ENOENT){rc=-1;break;}errno=0;}
 if(!ent && errno)rc=-1;int err=errno;if(rc==0 && fsync(fd)<0){rc=-1;err=errno;}closedir(d);errno=err;
 if(rc==0)rc=unlinkat(p,name,AT_REMOVEDIR);return rc;
}
static napi_value remove_key(napi_env e,napi_callback_info info) {
 napi_value v[3];root_cap *c=args(e,info,v,3);char s[4096],*leaf;bool recursive=false;if(!c)return fail(e);
 if(text_arg(e,v[1],s,sizeof(s))<0 || !key_ok(s) || napi_get_value_bool(e,v[2],&recursive)!=napi_ok){errno=EINVAL;return fail(e);}
 int fd=parent(c->fd,s,&leaf);if(fd<0)return fail(e);int rc=remove_at(fd,leaf,recursive,0),err=errno;
 if(rc==0){rc=fsync(fd);err=errno;}close(fd);errno=err;return rc<0?fail(e):nothing(e);
}
static napi_value list(napi_env e,napi_callback_info info) {
 napi_value v[2];root_cap *c=args(e,info,v,2);char s[4096];if(!c)return fail(e);
 if(text_arg(e,v[1],s,sizeof(s))<0 || (strcmp(s,".") && !key_ok(s))){errno=EINVAL;return fail(e);}
 int fd=safe_open(c->fd,s,O_RDONLY|O_DIRECTORY);if(fd<0)return fail(e);if(owned(fd,1)<0){int err=errno;close(fd);errno=err;return fail(e);}
 DIR *d=fdopendir(fd);if(!d){int err=errno;close(fd);errno=err;return fail(e);}napi_value result;napi_create_array(e,&result);unsigned i=0;struct dirent *ent;errno=0;
 while((ent=readdir(d))){if(!strcmp(ent->d_name,".") || !strcmp(ent->d_name,".."))continue;napi_value name;napi_create_string_utf8(e,ent->d_name,NAPI_AUTO_LENGTH,&name);napi_set_element(e,result,i++,name);errno=0;}
 int err=errno;closedir(d);errno=err;return err?fail(e):result;
}
static napi_value close_root(napi_env e,napi_callback_info info) {napi_value v[1];root_cap *c=args(e,info,v,1);if(!c)return fail(e);close(c->fd);c->fd=-1;return nothing(e);}
static napi_value lock_root(napi_env e,napi_callback_info info) {
 napi_value v[2];root_cap *c=args(e,info,v,2);int fd;struct stat a,b;if(!c)return fail(e);
 if(napi_get_value_int32(e,v[1],&fd)!=napi_ok){errno=EINVAL;return fail(e);}
 if(owned(fd,1)<0 || fstat(fd,&a)<0 || fstat(c->fd,&b)<0)return fail(e);
 if(a.st_dev!=b.st_dev || a.st_ino!=b.st_ino || (a.st_mode&0022)){errno=EPERM;return fail(e);}
 return flock(fd,LOCK_EX|LOCK_NB)<0?fail(e):nothing(e);
}
static napi_value remove_owned(napi_env e,napi_callback_info info) {
 napi_value v[3];root_cap *c=args(e,info,v,3);char s[4096],*leaf;int anchor;struct stat a,b;if(!c)return fail(e);
 if(text_arg(e,v[1],s,sizeof(s))<0 || !key_ok(s) || napi_get_value_int32(e,v[2],&anchor)!=napi_ok){errno=EINVAL;return fail(e);}
 if(owned(anchor,0)<0 || fstat(anchor,&a)<0)return fail(e);
 if(a.st_mode&0077){errno=EPERM;return fail(e);}
 int p=parent(c->fd,s,&leaf);if(p<0)return fail(e);
 int current=safe_open(p,leaf,O_RDONLY);if(current<0){int err=errno;close(p);errno=err;return fail(e);}
 int rc=owned(current,0);if(rc==0)rc=fstat(current,&b);
 if(rc==0 && (a.st_dev!=b.st_dev || a.st_ino!=b.st_ino || (b.st_mode&0077))){errno=EPERM;rc=-1;}
 /* All stage-2 workers retain the root flock; external hostile mutation is out of scope. */
 if(rc==0)rc=unlinkat(p,leaf,0);int err=errno;close(current);
 if(rc==0){rc=fsync(p);err=errno;}close(p);errno=err;return rc<0?fail(e):nothing(e);
}
static napi_value init(napi_env e,napi_value exports) {
 napi_property_descriptor props[]={
 {"root",0,root,0,0,0,napi_default,0},{"open",0,open_file,0,0,0,napi_default,0},{"directory",0,dir,0,0,0,napi_default,0},{"mkdir",0,mkdir_key,0,0,0,napi_default,0},{"rename",0,rename_key,0,0,0,napi_default,0},{"remove",0,remove_key,0,0,0,napi_default,0},{"list",0,list,0,0,0,napi_default,0},{"lock",0,lock_root,0,0,0,napi_default,0},{"removeOwned",0,remove_owned,0,0,0,napi_default,0},{"close",0,close_root,0,0,0,napi_default,0}};
 napi_define_properties(e,exports,sizeof(props)/sizeof(props[0]),props);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
