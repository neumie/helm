#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

#include <cstring>

#include "node-api-fallback.h"

namespace {

using SetFrameImplementation = void (*)(id, SEL, NSRect, BOOL);
using SetFrameAnimatedImplementation = void (*)(id, SEL, NSRect, BOOL, BOOL);

bool installed = false;
SetFrameImplementation originalSetFrame = nullptr;
SetFrameAnimatedImplementation originalSetFrameAnimated = nullptr;
NSInteger guardedWindowNumber = 0;
double guardedUntil = 0;
constexpr double kTabDoubleClickGuardSeconds = 1.5;

bool installHook(Class target,
                 SEL selector,
                 IMP replacement,
                 IMP* original) {
  Method method = class_getInstanceMethod(target, selector);
  if (!method)
    return false;
  *original = method_getImplementation(method);
  if (class_addMethod(target, selector, replacement,
                      method_getTypeEncoding(method)))
    return true;
  method_setImplementation(method, replacement);
  return true;
}

bool shouldBlockFrame(NSWindow* window, NSRect frame) {
  return window.windowNumber == guardedWindowNumber &&
         NSProcessInfo.processInfo.systemUptime <= guardedUntil &&
         !window.inLiveResize && !NSEqualRects(window.frame, frame);
}

void guardedSetFrame(id self,
                     SEL selector,
                     NSRect frame,
                     BOOL display) {
  NSWindow* window = static_cast<NSWindow*>(self);
  if (!shouldBlockFrame(window, frame))
    originalSetFrame(self, selector, frame, display);
}

void guardedSetFrameAnimated(id self,
                             SEL selector,
                             NSRect frame,
                             BOOL display,
                             BOOL animate) {
  NSWindow* window = static_cast<NSWindow*>(self);
  if (!shouldBlockFrame(window, frame))
    originalSetFrameAnimated(self, selector, frame, display, animate);
}

NSWindow* WindowFromHandle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  void* handleData = nullptr;
  size_t handleLength = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != 0 ||
      argc != 1 ||
      napi_get_buffer_info(env, argv[0], &handleData, &handleLength) != 0 ||
      handleLength < sizeof(NSView*)) {
    napi_throw_error(env, nullptr, "A macOS native window handle is required");
    return nil;
  }

  void* nativeView = nullptr;
  std::memcpy(&nativeView, handleData, sizeof(nativeView));
  NSView* view = (__bridge NSView*)nativeView;
  if (!view.window)
    napi_throw_error(env, nullptr, "The native view has no NSWindow");
  return view.window;
}

napi_value Install(napi_env env, napi_callback_info info) {
  if (!installed) {
    Class window = NSClassFromString(@"ElectronNSWindow");
    IMP capturedSetFrame = nullptr;
    IMP capturedSetFrameAnimated = nullptr;
    const bool hooksInstalled =
        window &&
        installHook(window, @selector(setFrame:display:),
                    reinterpret_cast<IMP>(&guardedSetFrame),
                    &capturedSetFrame) &&
        installHook(window, @selector(setFrame:display:animate:),
                    reinterpret_cast<IMP>(&guardedSetFrameAnimated),
                    &capturedSetFrameAnimated);
    if (!hooksInstalled) {
      napi_throw_error(env, nullptr,
                       "ElectronNSWindow double-click frame hooks are unavailable");
      return nullptr;
    }
    originalSetFrame =
        reinterpret_cast<SetFrameImplementation>(capturedSetFrame);
    originalSetFrameAnimated =
        reinterpret_cast<SetFrameAnimatedImplementation>(
            capturedSetFrameAnimated);
    installed = true;
  }

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value Arm(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowFromHandle(env, info);
  if (!window)
    return nullptr;
  guardedWindowNumber = window.windowNumber;
  guardedUntil = NSProcessInfo.processInfo.systemUptime +
                 kTabDoubleClickGuardSeconds;

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value install;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, Install, nullptr,
                       &install);
  napi_set_named_property(env, exports, "install", install);

  napi_value arm;
  napi_create_function(env, "arm", NAPI_AUTO_LENGTH, Arm, nullptr, &arm);
  napi_set_named_property(env, exports, "arm", arm);
  return exports;
}

}  // namespace

extern "C" __attribute__((visibility("default"))) int32_t
node_api_module_get_api_version_v1() {
  return 8;
}

extern "C" __attribute__((visibility("default"))) napi_value
napi_register_module_v1(napi_env env, napi_value exports) {
  return Init(env, exports);
}
