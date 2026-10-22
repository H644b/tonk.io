export function createNativeHarness(
  source: string,
  options?: { nativeEvent?: (type: string, context: any) => void },
): { native: any; context: any; run(code: string, timeout?: number): any };
