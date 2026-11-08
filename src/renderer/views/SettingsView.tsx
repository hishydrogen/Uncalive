import { useState } from 'react';
import { call, qualityDetails, qualityTitles } from '../api';
import { Header, NumberField, Segmented, Select, Toggle } from '../components';
import type { AppState } from '../../shared/types';
import { updateArchive, updateOptions } from './OptionsPanel';

type Tab = 'general' | 'media' | 'archive' | 'speed';

export function SettingsView({ state }: { state: AppState }) {
  const [tab, setTab] = useState<Tab>('general');
  return (
    <div className="screen">
      <Header title="설정">
        <Segmented<Tab> label="설정 종류" value={tab} onChange={setTab} options={[
          { value: 'general', label: '일반' }, { value: 'media', label: '미디어' }, { value: 'archive', label: '페이지 저장' }, { value: 'speed', label: '속도' },
        ]} />
      </Header>
      <div className="scroll">
        <div className="settings">
          {tab === 'general' && <General state={state} />}
          {tab === 'media' && <Media state={state} />}
          {tab === 'archive' && <ArchiveSettings state={state} />}
          {tab === 'speed' && <Speed state={state} />}
        </div>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <span>{props.label}</span>
      <div className="row">{props.children}</div>
    </div>
  );
}

function General({ state }: { state: AppState }) {
  const options = state.options;
  const jobActive = state.job !== undefined && ['running', 'paused', 'waitingForChallenge'].includes(state.job.status);
  const custom = options.pages.first !== 1 || options.pages.last !== undefined;
  return (
    <>
      <section className="card">
        <Row label="저장 위치">
          <span className="path" title={options.destination}><span dir="ltr">{options.destination}</span></span>
          <button onClick={() => void call('chooseDestination')} disabled={jobActive}>변경…</button>
        </Row>
        <Toggle label="계정마다 보관함 나누기" checked={state.useAccountFolder} disabled={jobActive} onChange={(value) => void call('setUseAccountFolder', value)} />
        <p className="caption">현재 보관함: {state.libraryRoot}<br />계정은 닉네임이 아니라 로그인 아이디로 구분하므로, 닉네임이 바뀌거나 겹쳐도 보관함이 섞이지 않습니다. 계정을 바꾸면 그 계정의 보관함과 주소 수집 목록으로 전환됩니다.</p>
      </section>

      <section className="card">
        <h3>스크랩 목록</h3>
        <Row label="불러올 범위">
          <Segmented<string> label="불러올 범위" value={custom ? 'custom' : 'all'} onChange={(value) => updateOptions(state, { pages: value === 'all' ? { first: 1 } : { first: 1, last: 10 } })} options={[
            { value: 'all', label: '전체' }, { value: 'custom', label: '페이지 지정' },
          ]} />
        </Row>
        {custom && (
          <Row label="페이지">
            <NumberField label="시작 페이지" value={options.pages.first} min={1} max={100_000} onChange={(first) => updateOptions(state, { pages: { ...options.pages, first, last: Math.max(options.pages.last ?? first, first) } })} />
            페이지부터
            <NumberField label="끝 페이지" value={options.pages.last ?? options.pages.first} min={options.pages.first} max={100_000} onChange={(last) => updateOptions(state, { pages: { ...options.pages, last } })} />
            페이지까지
          </Row>
        )}
      </section>

      <section className="card">
        <h3>새 스크랩 자동 확인</h3>
        <Row label="확인 주기">
          <Select<string> label="확인 주기" value={String(state.autoCheckHours)} onChange={(value) => void call('setAutoCheckHours', Number(value))} options={[
            { value: '0', label: '끄기' }, { value: '1', label: '1시간' }, { value: '6', label: '6시간' }, { value: '12', label: '12시간' }, { value: '24', label: '하루' },
          ]} />
        </Row>
        <Toggle label="새 스크랩 자동으로 받기" checked={state.autoDownloadNew} disabled={state.autoCheckHours === 0} onChange={(value) => void call('setAutoDownloadNew', value)} />
        <Row label="마지막 확인">
          <span>{state.lastCheck ? new Date(state.lastCheck).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '없음'}</span>
          <button onClick={() => void call('checkNow')} disabled={state.isBusy || state.login !== 'loggedIn'}>지금 확인</button>
        </Row>
        <p className="caption">앱이 실행 중일 때는 첫 페이지부터 확인해 이전에 불러온 글이 나올 때까지 새 스크랩을 찾으므로, 여러 페이지를 스크랩해도 놓치지 않습니다. 자동 확인을 켜 두면 창을 닫아도 앱이 알림 영역에 남아 동작하며, 알림에는 글 제목이 표시되지 않습니다.</p>
      </section>

      <section className="card">
        <h3>폴더</h3>
        <Row label="폴더 이름">
          <Select label="폴더 이름" value={options.folderNaming} onChange={(folderNaming) => updateOptions(state, { folderNaming })} options={[
            { value: 'title', label: '제목' }, { value: 'idAndTitle', label: '글 번호_제목' },
          ]} />
        </Row>
        <Toggle label="채널별 폴더로 나누기" checked={options.groupByChannel} onChange={(groupByChannel) => updateOptions(state, { groupByChannel })} />
        <Row label="이름 최대 길이">
          <NumberField label="이름 최대 길이" value={options.folderNameMaxLength} min={20} max={120} onChange={(folderNameMaxLength) => updateOptions(state, { folderNameMaxLength })} /> 자
        </Row>
      </section>
    </>
  );
}

function Media({ state }: { state: AppState }) {
  const options = state.options;
  return (
    <>
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
        <Toggle label="동영상 표지 이미지" checked={options.includeVideoPosters} onChange={(includeVideoPosters) => updateOptions(state, { includeVideoPosters })} />
      </section>
      <section className="card">
        <Row label="파일 이름">
          <Select label="파일 이름" value={options.fileNaming} onChange={(fileNaming) => updateOptions(state, { fileNaming })} options={[
            { value: 'sequence', label: '01.jpg' }, { value: 'sequenceAndOriginalName', label: '01_원본이름.jpg' },
          ]} />
        </Row>
      </section>
    </>
  );
}

function ArchiveSettings({ state }: { state: AppState }) {
  const archive = state.options.archive;
  return (
    <>
      <section className="card">
        <Toggle label="오프라인 페이지 (index.html)" checked={archive.offlineHTML} onChange={(offlineHTML) => updateArchive(state, { offlineHTML })} />
        <Toggle label="댓글 포함" checked={archive.includeComments} disabled={!archive.offlineHTML} onChange={(includeComments) => updateArchive(state, { includeComments })} />
        <p className="caption">다운로드한 미디어가 본문에 연결되어 있어, 인터넷 없이도 어느 브라우저에서나 열 수 있습니다.</p>
      </section>
      <section className="card">
        <Toggle label="글 정보 (post.json)" checked={archive.metadataJSON} onChange={(metadataJSON) => updateArchive(state, { metadataJSON })} />
        <Toggle label="웹 아카이브 (page.mhtml)" checked={archive.webArchive} onChange={(webArchive) => updateArchive(state, { webArchive })} />
        <Toggle label="페이지 원문 (page.html)" checked={archive.rawHTML} onChange={(rawHTML) => updateArchive(state, { rawHTML })} />
        <p className="caption">웹 아카이브는 페이지 전체를 한 파일에 담아 Edge나 Chrome에서 열 수 있으며, 글마다 용량을 더 차지합니다. 페이지 원문에는 로그인한 계정의 닉네임이 포함될 수 있습니다.</p>
      </section>
    </>
  );
}

function Seconds(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <Row label={props.label}>
      <input type="range" aria-label={props.label} min={props.min} max={props.max} step={props.step} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
      <span className="mono-digits seconds">{props.value.toFixed(1)}초</span>
    </Row>
  );
}

function Speed({ state }: { state: AppState }) {
  const options = state.options;
  return (
    <>
      <section className="card">
        <Seconds label="글 사이 대기" value={options.pageDelay} min={1} max={10} step={0.5} onChange={(pageDelay) => updateOptions(state, { pageDelay })} />
        <Seconds label="파일 사이 대기" value={options.mediaDelay} min={0} max={2} step={0.1} onChange={(mediaDelay) => updateOptions(state, { mediaDelay })} />
        <p className="caption">글을 너무 빠르게 연속해서 열면 이용이 제한될 수 있습니다. 앞선 글의 파일을 받는 동안 다음 글을 미리 불러오므로, 대기 시간을 늘려도 전체 소요 시간은 크게 늘어나지 않습니다.</p>
      </section>
      <section className="card">
        <Row label="CDN 동시 다운로드">
          <Segmented<number> label="CDN 동시 다운로드" value={options.maxConcurrentDownloads} onChange={(maxConcurrentDownloads) => updateOptions(state, { maxConcurrentDownloads })} options={[1, 2, 4, 6].map((value) => ({ value, label: `${value}개` }))} />
        </Row>
        <Row label="실패 시 재시도">
          <Segmented<number> label="실패 시 재시도" value={options.retryCount} onChange={(retryCount) => updateOptions(state, { retryCount })} options={[0, 1, 3, 5].map((value) => ({ value, label: `${value}회` }))} />
        </Row>
        <p className="caption">원본 서버는 자체 연결 제한에 맞춰 동시 다운로드 수를 2개로 고정합니다.</p>
      </section>
      <p className="caption center">언카라이브 {state.version}</p>
    </>
  );
}
