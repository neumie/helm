{
  "targets": [
    {
      "target_name": "helm_native_window_zoom_guard",
      "sources": ["native-window-zoom-guard.mm"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "12.0"
          }
        }]
      ]
    }
  ]
}
