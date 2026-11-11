import { Settings } from 'lucide-react';
import { call, qualityDetails, qualityTitles } from '../api';
import { Segmented, Toggle } from '../components';
import type { AppState, DownloadOptions } from '../../shared/types';

export function updateOptions(state: AppState, patch: Partial<DownloadOptions>): void {
  void call('setOptions', { ...state.options, ...patch });
}

export function updateArchive(state: AppState, patch: Partial<DownloadOptions['archive']>): void {
  void call('setOptions', { ...state.options, archive: { ...state.options.archive, ...patch } });
}

/** 다운로드 전에 자주 바꾸는 옵션을 목록 옆에서 바로 보여 줍니다. */
export function OptionsPanel({ state, closing, slide }: { state: AppState; closing?: boolean; slide?: boolean }) {
  const options = state.options;
  const jobActive = state.job !== undefined && ['running', 'paused', 'waitingForChallenge'].includes(state.job.status);
  return (
    <aside className={`inspector ${closing ? 'closing' : slide ? 'slide' : ''}`} aria-hidden={closing}>
      <section className="card">
        <h3>저장 위치</h3>
        <div className="row between">
          <span className="caption path" title={state.libraryRoot}><span dir="ltr">{state.libraryRoot}</span></span>
          <button onClick={() => void call('chooseDestination')} disabled={jobActive}>변경…</button>
        </div>
      </section>
      <section className="card">
        <h3>화질</h3>
        <Segmented value={options.quality} onChange={(quality) => updateOptions(state, { quality })} label="화질" options={[
          { value: 'original', label: qualityTitles.original }, { value: 'balanced', label: qualityTitles.balanced }, { value: 'display', label: qualityTitles.display },
        ]} />
        <p className="caption">{qualityDetails[options.quality]}</p>
      </section>
      <section className="card">
        <h3>받을 파일</h3>
        <Toggle label="이미지" checked={options.includeImages} onChange={(includeImages) => updateOptions(state, { includeImages })} />
        <Toggle label="동영상" checked={options.includeVideos} onChange={(includeVideos) => updateOptions(state, { includeVideos })} />
        <Toggle label="오디오" checked={options.includeAudio} onChange={(includeAudio) => updateOptions(state, { includeAudio })} />
        <Toggle label="본문 아카콘" checked={options.includeEmoticons} onChange={(includeEmoticons) => updateOptions(state, { includeEmoticons })} />
      </section>
      <section className="card">
        <h3>페이지 저장</h3>
        <Toggle label="오프라인 페이지" checked={options.archive.offlineHTML} onChange={(offlineHTML) => updateArchive(state, { offlineHTML })} />
        <Toggle label="댓글 포함" checked={options.archive.includeComments} disabled={!options.archive.offlineHTML} onChange={(includeComments) => updateArchive(state, { includeComments })} />
      </section>
      <button className="link" onClick={() => void call('setSection', 'settings')}><Settings size={14} /> 모든 설정 보기</button>
    </aside>
  );
}
