require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoPdfAnnotation'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'Youmi Lens'
  s.homepage       = 'https://github.com/youmi-lens/youmi-lens-ipad'
  s.platforms      = {
    :ios => '15.1'
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
  # __tests__ holds standalone Simulator regression fixtures with top-level
  # executable code (run manually via `simctl spawn`). They must never be
  # compiled into the app target — top-level code is illegal in a framework and
  # would break the build. Exclude the whole directory from the pod sources.
  s.exclude_files = "**/__tests__/**/*"
end
