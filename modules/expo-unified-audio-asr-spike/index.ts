/**
 * SPIKE module entry — unified AVAudioEngine capture.
 *
 * App code should prefer `lib/unifiedAudioAsrSpike.ts`, which resolves the
 * native module safely with `requireOptionalNativeModule` and no-ops when the
 * native binary is absent (Expo Go / pre-rebuild). This file exists so Expo
 * autolinking discovers the local module during `npx expo prebuild`.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type SpikePcmFrameEvent = {
  base64: string;
  sampleRate: number;
  sampleCount: number;
  encoding: 'pcm16le';
  channelCount: number;
};

export type SpikeStatus = {
  isRunning: boolean;
  fileUri?: string;
  framesEmitted: number;
  sampleRate: number;
  channelCount: number;
  encoding: string;
  implementation: string;
};

type EventSubscription = { remove: () => void };

export type ExpoUnifiedAudioAsrSpikeModule = {
  isAvailable: () => Promise<boolean>;
  start: () => Promise<SpikeStatus>;
  stop: () => Promise<SpikeStatus>;
  getStatus: () => Promise<SpikeStatus>;
  addListener?: (
    eventName: 'onPcmFrame',
    listener: (event: SpikePcmFrameEvent) => void,
  ) => EventSubscription;
};

export default requireOptionalNativeModule<ExpoUnifiedAudioAsrSpikeModule>(
  'ExpoUnifiedAudioAsrSpike',
);
