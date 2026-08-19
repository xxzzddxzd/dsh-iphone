#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <unistd.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    const char *path = argc > 1
      ? argv[1]
      : "/var/jb/tmp/DSHNotifierBridge.test.dylib";
    void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (handle == NULL) {
      fprintf(stderr, "dlopen failed: %s\n", dlerror());
      return 1;
    }
    printf("READY pid=%d (press return to exit)\n", getpid());
    char byte = 0;
    while (read(STDIN_FILENO, &byte, 1) < 0 && errno == EINTR) {}
    (void)handle;
  }
  return 0;
}
