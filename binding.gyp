{
  "targets": [
    {
      "target_name": "agent-relay-windows-job",
      "type": "executable",
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": ["native/windows-job-launcher.cpp"],
            "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/utf-8"]
              }
            }
          },
          {
            "type": "none"
          }
        ]
      ]
    },
    {
      "target_name": "agent-relay-fs-guard",
      "type": "executable",
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": ["native/windows-fs-guard.cpp"],
            "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
            "libraries": ["ntdll.lib", "bcrypt.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/utf-8", "/EHsc"]
              }
            }
          }
        ],
        [
          "OS=='linux'",
          {
            "sources": ["native/linux-fs-guard.cpp"],
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc": [
              "-fexceptions",
              "-Wall",
              "-Wextra",
              "-fstack-protector-strong",
              "-fPIE"
            ],
            "ldflags": ["-pie", "-Wl,-z,relro,-z,now"]
          }
        ],
        [
          "OS!='win' and OS!='linux'",
          {
            "type": "none"
          }
        ]
      ]
    }
  ]
}
