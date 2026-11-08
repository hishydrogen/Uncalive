import { describe, expect, test } from 'vitest';
import { legacySettings, parsePlist } from '../src/core/migration';
import { mergeOptions } from '../src/core/options';

const options = {
  destination: 'file:///Users/someone/%EB%B3%B4%EA%B4%80/', quality: 'balanced', includeEmoticons: true,
  pages: { first: 1 }, archive: { offlineHTML: true, includeComments: false, metadataJSON: true, webArchive: false, rawHTML: false },
  pageDelay: 3, source: '스크랩',
};
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>autoCheckHours</key>
	<integer>6</integer>
	<key>autoDownloadNewScraps</key>
	<true/>
	<key>downloadOptions.v3</key>
	<data>
	${Buffer.from(JSON.stringify(options)).toString('base64')}
	</data>
	<key>libraryLayout</key>
	<string>list</string>
	<key>useAccountFolder</key>
	<false/>
	<key>username</key>
	<string>시험 &amp; 계정</string>
</dict>
</plist>`;

describe('예전 맥 앱 설정 가져오기', () => {
  test('defaults export 결과를 읽는다', () => {
    const values = parsePlist(xml);
    expect(values.autoCheckHours).toBe(6);
    expect(values.useAccountFolder).toBe(false);
    expect(values.username).toBe('시험 & 계정');
    expect(Buffer.isBuffer(values['downloadOptions.v3'])).toBe(true);
  });

  test('저장 위치와 옵션을 이어받고 출처는 버린다', () => {
    const legacy = legacySettings(parsePlist(xml));
    expect(legacy.options?.destination).toBe('/Users/someone/보관/');
    expect(legacy.options?.quality).toBe('balanced');
    expect('source' in (legacy.options ?? {})).toBe(false);
    expect(legacy).toMatchObject({ useAccountFolder: false, username: '시험 & 계정', autoCheckHours: 6, autoDownloadNewScraps: true });
    const merged = mergeOptions(legacy.options, '/기본');
    expect(merged.archive.includeComments).toBe(false);
    expect(merged.includeVideos).toBe(true);
    expect(merged.pageDelay).toBe(3);
  });

  test('설정이 없으면 아무것도 바꾸지 않는다', () => {
    expect(legacySettings(parsePlist('<plist><dict></dict></plist>'))).toEqual({});
  });
});
