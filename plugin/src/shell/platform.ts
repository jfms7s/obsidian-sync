import { Platform } from 'obsidian';

/** A default device name and the platform the server lists it under. */
export function describePlatform(): { name: string; platform: string } {
  if (Platform.isIosApp) return { name: 'iPhone or iPad', platform: 'ios' };
  if (Platform.isAndroidApp) return { name: 'Android device', platform: 'android' };
  if (Platform.isMacOS) return { name: 'Mac', platform: 'macos' };
  if (Platform.isWin) return { name: 'Windows PC', platform: 'windows' };
  if (Platform.isLinux) return { name: 'Linux PC', platform: 'linux' };
  return { name: 'Device', platform: 'other' };
}
