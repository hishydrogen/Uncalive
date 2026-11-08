import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { parseTargets } from '../../core/targets';
import { call } from '../api';
import { Dialog, NumberField, Segmented } from '../components';
import type { AppState, ListScope } from '../../shared/types';

type Mode = 'first' | 'range' | 'days' | 'all';

/** 스크랩하지 않은 글이나 채널, 개념글, 검색 결과를 주소로 모읍니다. */
export function AddURLsDialog(props: { state: AppState; onClose: () => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('first');
  const [firstPages, setFirstPages] = useState(5);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(10);
  const [days, setDays] = useState(30);

  const targets = useMemo(() => parseTargets(text), [text]);
  const hasList = targets.some((target) => target.type === 'list');
  // 페이지를 읽는 창이 하나라서 다운로드나 목록 읽기 중에는 목록 주소를 읽을 수 없습니다.
  const blocked = hasList && props.state.isBusy;

  const scope = (): ListScope => {
    switch (mode) {
      case 'first': return { firstPage: 1, lastPage: firstPages };
      case 'range': return { firstPage: rangeStart, lastPage: Math.max(rangeEnd, rangeStart) };
      case 'days': return { firstPage: 1, since: new Date(Date.now() - days * 86_400_000).toISOString() };
      case 'all': return { firstPage: 1 };
    }
  };

  return (
    <Dialog title="주소 추가" onClose={props.onClose}>
      <p className="muted">아카라이브 게시글 주소나 목록 주소를 한 줄에 하나씩 붙여 넣으세요. 채널, 개념글, 카테고리, 검색 결과, 작성자 글 목록을 모두 지원합니다.</p>
      <textarea autoFocus className="mono" rows={7} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
      <span className="caption">인식된 주소 {targets.length}개</span>

      {blocked ? (
        <p className="warning"><AlertTriangle size={15} /> 다운로드나 목록 불러오기가 진행 중일 때는 목록 주소를 불러올 수 없습니다. 작업이 끝난 뒤 다시 추가하거나 개별 글 주소만 입력해 주세요.</p>
      ) : hasList && (
        <fieldset className="group">
          <legend>목록을 불러올 범위</legend>
          <Segmented<Mode> value={mode} onChange={setMode} label="범위" options={[
            { value: 'first', label: '앞쪽 페이지' }, { value: 'range', label: '페이지 구간' }, { value: 'days', label: '최근 기간' }, { value: 'all', label: '끝까지' },
          ]} />
          <div className="row">
            {mode === 'first' && <>처음 <NumberField label="페이지 수" value={firstPages} min={1} max={100_000} onChange={setFirstPages} /> 페이지</>}
            {mode === 'range' && (
              <>
                <NumberField label="시작 페이지" value={rangeStart} min={1} max={100_000} onChange={setRangeStart} /> 페이지부터
                <NumberField label="끝 페이지" value={rangeEnd} min={1} max={100_000} onChange={setRangeEnd} /> 페이지까지
              </>
            )}
            {mode === 'days' && <>최근 <NumberField label="일 수" value={days} min={1} max={36_500} onChange={setDays} />일 이내의 글</>}
            {mode === 'all' && <span className="caption"><AlertTriangle size={13} /> 규모가 큰 채널은 페이지가 매우 많을 수 있습니다. 불러오는 도중 언제든 중지할 수 있으며, 그때까지 불러온 글은 목록에 그대로 남습니다.</span>}
          </div>
        </fieldset>
      )}

      <div className="dialog-buttons">
        <button onClick={props.onClose}>취소</button>
        <button className="primary" disabled={targets.length === 0 || blocked} onClick={() => {
          void call('addTargets', text, scope());
          props.onClose();
        }}>추가</button>
      </div>
    </Dialog>
  );
}
