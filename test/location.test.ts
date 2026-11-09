import { describe, expect, test } from 'vitest';
import { isNetworkPath } from '../src/core/location';

describe('네트워크 위치', () => {
  test('공유 폴더 경로를 알아본다', () => {
    expect(isNetworkPath('\\\\Mac\\Home\\Desktop\\Uncalive\\Uncalive.exe')).toBe(true);
    expect(isNetworkPath('\\\\?\\UNC\\Mac\\Home\\Desktop')).toBe(true);
    expect(isNetworkPath('//server/share/app')).toBe(true);
  });

  test('로컬 경로는 그냥 둔다', () => {
    expect(isNetworkPath('C:\\Users\\me\\Downloads\\Uncalive\\Uncalive.exe')).toBe(false);
    expect(isNetworkPath('\\\\?\\C:\\Users\\me\\Uncalive')).toBe(false);
  });
});
