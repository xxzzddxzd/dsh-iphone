#import <Foundation/Foundation.h>

// LaunchServices requires a real executable before it will register an app
// bundle as a notification section. The bundle is hidden from SpringBoard and
// never handles notification taps; DSHNotifierBridge opens those in the user's
// default browser.
int main(void) {
  @autoreleasepool {
    return 0;
  }
}
