#define _GNU_SOURCE
#include <node_api.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <errno.h>
#include <string.h>
/* Research-only, read-only acquisition. No enrollment or ownership assertion. */
static napi_value acquire(napi_env e,napi_callback_info i){
 napi_value a,v;size_t n=1,len=0;if(napi_get_cb_info(e,i,&n,&a,0,0)!=napi_ok||n!=1)goto fail;
 char path[4096];napi_valuetype t;if(napi_typeof(e,a,&t)!=napi_ok)goto fail;
 if(n!=1||t!=napi_string||napi_get_value_string_utf8(e,a,0,0,&len)!=napi_ok||len<2||len>=sizeof(path))goto fail;
 napi_get_value_string_utf8(e,a,path,sizeof(path),&n);if(n!=len||strlen(path)!=len||path[0]!='/')goto fail;
 int root=open("/",O_PATH|O_DIRECTORY|O_CLOEXEC);if(root<0)goto fail;
 struct open_how h={.flags=O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS};
 int fd=syscall(SYS_openat2,root,path+1,&h,sizeof(h));close(root);if(fd<0)goto fail;
 napi_create_int32(e,fd,&v);return v;
 fail:napi_throw_error(e,"EOBSERVE","read-only acquisition failed");return 0;
}
static napi_value init(napi_env e,napi_value out){napi_property_descriptor p={"acquire",0,acquire,0,0,0,napi_default,0};napi_define_properties(e,out,1,&p);return out;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
