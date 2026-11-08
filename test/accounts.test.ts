import { describe, expect, test } from 'vitest';
import { chooseAccountFolder } from '../src/core/accounts';

describe('계정 보관함', () => {
  const has = (...names: string[]) => (name: string) => names.includes(name);

  test('예전 닉네임 보관함이 있으면 이어 쓴다', () => {
    expect(chooseAccountFolder('first', '물방울', {}, has('물방울'))).toBe('물방울');
  });

  test('닉네임 보관함이 없으면 아이디로 만든다', () => {
    expect(chooseAccountFolder('first', '물방울', {}, has())).toBe('first');
  });

  test('닉네임이 같은 다른 계정이 이미 쓰는 보관함은 넘보지 않는다', () => {
    const accounts = { first: { folder: '물방울', nickname: '물방울' } };
    expect(chooseAccountFolder('second', '물방울', accounts, has('물방울'))).toBe('second');
  });

  test('대소문자만 다른 폴더도 같은 폴더로 본다', () => {
    const accounts = { first: { folder: 'Drop' } };
    expect(chooseAccountFolder('second', 'drop', accounts, has('drop'))).toBe('second');
  });
});
