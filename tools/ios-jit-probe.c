#include <dlfcn.h>
#include <errno.h>
#include <libkern/OSCacheControl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#ifndef MAP_JIT
#define MAP_JIT 0x800
#endif

typedef void (*jit_write_protect_fn)(int);
typedef int (*jit_write_protect_supported_fn)(void);

int main(void) {
  jit_write_protect_fn protect =
      (jit_write_protect_fn)dlsym(RTLD_DEFAULT, "pthread_jit_write_protect_np");
  jit_write_protect_supported_fn supported =
      (jit_write_protect_supported_fn)dlsym(
          RTLD_DEFAULT, "pthread_jit_write_protect_supported_np");

  printf("pthread_jit_write_protect_np=%p\n", (void *)protect);
  printf("pthread_jit_write_protect_supported_np=%p", (void *)supported);
  if (supported != NULL) printf(" result=%d", supported());
  putchar('\n');

  size_t page_size = (size_t)getpagesize();
  void *page = mmap(NULL, page_size, PROT_READ | PROT_WRITE | PROT_EXEC,
                    MAP_PRIVATE | MAP_ANON | MAP_JIT, -1, 0);
  if (page == MAP_FAILED) {
    fprintf(stderr, "mmap(MAP_JIT): %s; retrying without MAP_JIT\n",
            strerror(errno));
    page = mmap(NULL, page_size, PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANON, -1, 0);
    if (page == MAP_FAILED) {
      fprintf(stderr, "mmap(RW): %s\n", strerror(errno));
      return 2;
    }
    printf("anonymous RW page=%p size=%zu\n", page, page_size);
  } else {
    printf("MAP_JIT page=%p size=%zu\n", page, page_size);
  }

  static const unsigned int return_42[] = {
      0x52800540,
      0xd65f03c0,
  };
  if (protect != NULL) protect(0);
  memcpy(page, return_42, sizeof(return_42));
  sys_icache_invalidate(page, sizeof(return_42));
  if (protect != NULL) {
    protect(1);
  } else if (mprotect(page, page_size, PROT_READ | PROT_EXEC) != 0) {
    fprintf(stderr, "mprotect(RX): %s\n", strerror(errno));
    return 3;
  }

  int (*function)(void) = (int (*)(void))page;
  int result = function();
  printf("executed generated code: result=%d\n", result);
  return result == 42 ? 0 : 4;
}
