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
    }
  ]
}
