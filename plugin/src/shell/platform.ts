import { Platform } from 'obsidian';

/** Bytes of file content a push round holds on this device: less on a phone, whose memory is tighter. */
export function pushRoundBytes(): number | undefined {
  return Platform.isMobile ? 16 << 20 : undefined;
}

/** A default device name and the platform the server lists it under. */
export function describePlatform(): { name: string; platform: string } {
  if (Platform.isIosApp) return { name: 'iPhone or iPad', platform: 'ios' };
  if (Platform.isAndroidApp) return { name: 'Android device', platform: 'android' };
  if (Platform.isMacOS) return { name: 'Mac', platform: 'macos' };
  if (Platform.isWin) return { name: 'Windows PC', platform: 'windows' };
  if (Platform.isLinux) return { name: 'Linux PC', platform: 'linux' };
  return { name: 'Device', platform: 'other' };
}
