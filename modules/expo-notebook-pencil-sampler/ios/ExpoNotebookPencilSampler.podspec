require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoNotebookPencilSampler'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'Youmi Lens'
  s.homepage       = 'https://github.com/youmi-lens/youmi-lens-ipad'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # __tests__ holds a standalone Simulator regression fixture with top-level
  # executable code (@main, run manually via `simctl spawn` — see
  # scripts/notebook-pencil-sample-normalization.test.mjs). It must never be
  # compiled into the app target: a second `@main`/`_main` collides with the
  # app's own entry point at link time. Exclude the whole directory, matching
  # expo-pdf-annotation's podspec, which has the identical fixture pattern.
  s.exclude_files = "**/__tests__/**/*"
end
