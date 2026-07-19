import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export const DURABLE_RECORDER_CONTRACT_VERSION = 1 as const;

export type DurableRecorderCapabilities = {
  moduleAvailable: boolean;
  contractVersion: typeof DURABLE_RECORDER_CONTRACT_VERSION;
  platform: string;
  implementation: string;
};

type NativeDurableRecorderModule = {
  getCapabilities: () => Promise<unknown>;
};

function loadNativeModule(): NativeDurableRecorderModule | null {
  try {
    return requireOptionalNativeModule<NativeDurableRecorderModule>('ExpoDurableRecorder');
  } catch {
    return null;
  }
}

function unavailableCapabilities(): DurableRecorderCapabilities {
  return {
    moduleAvailable: false,
    contractVersion: DURABLE_RECORDER_CONTRACT_VERSION,
    platform: typeof Platform.OS === 'string' ? Platform.OS : 'unknown',
    implementation: 'unavailable',
  };
}

const nativeModule = loadNativeModule();

export async function getCapabilities(): Promise<DurableRecorderCapabilities> {
  if (!nativeModule) return unavailableCapabilities();

  try {
    const result = await nativeModule.getCapabilities();
    if (!result || typeof result !== 'object') return unavailableCapabilities();

    const capabilities = result as Partial<DurableRecorderCapabilities>;
    if (
      capabilities.moduleAvailable !== true ||
      capabilities.contractVersion !== DURABLE_RECORDER_CONTRACT_VERSION ||
      capabilities.platform !== 'ios' ||
      capabilities.implementation !== 'native-placeholder'
    ) {
      return unavailableCapabilities();
    }

    return {
      moduleAvailable: true,
      contractVersion: DURABLE_RECORDER_CONTRACT_VERSION,
      platform: 'ios',
      implementation: 'native-placeholder',
    };
  } catch {
    return unavailableCapabilities();
  }
}
