import { ExternalLink, X } from 'lucide-react';
import { call, formatAgo } from '../api';
import { Dialog, showToast } from '../components';
import type { AppState, UpdateState } from '../../shared/types';
import appIcon from '../../../resources/icon.svg';

const repository = 'https://github.com/hishydrogen/Uncalive';
const platformNames: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** 정보 창과 알림 카드에서 '다운로드'를 눌렀을 때입니다. 내려받기는 기본 웹 브라우저가 합니다. */
async function download(): Promise<void> {
  const opened = await call('downloadUpdate');
  showToast(opened ? '웹 브라우저에서 설치 파일을 내려받습니다. 완료되면 파일을 실행해 설치해 주세요' : '릴리스 페이지에서 운영체제에 맞는 파일을 내려받아 주세요');
}

function UpdateStatus({ update }: { update: UpdateState }) {
  if (update.checking) return <span className="faint">확인 중…</span>;
  const result = update.result;
  if (!result) return <span className="faint">{update.auto ? '아직 확인하지 않았습니다' : '자동 확인이 꺼져 있습니다'}</span>;
  if (!result.ok) return <span className="warning-text">확인하지 못했습니다. {result.error}</span>;
  if (result.newer) {
    return (
      <span>
        {result.latest} 버전이 나왔습니다 <button className="link" onClick={() => void download()}>다운로드</button>
      </span>
    );
  }
  return <span>최신 버전입니다{update.checkedAt ? <small> · {formatAgo(update.checkedAt)} 확인</small> : null}</span>;
}

/** '언카라이브에 관하여' 창입니다. 나무덤프의 정보 창과 같은 짜임으로, 세 운영체제에서 똑같이 보입니다. */
export function AboutDialog({ state }: { state: AppState }) {
  const close = () => void call('setAboutOpen', false);
  const arch = state.platform === 'darwin' && state.arch === 'arm64' ? 'Apple Silicon' : state.arch;
  const platform = platformNames[state.platform] ?? state.platform;
  return (
    <Dialog title="언카라이브에 관하여" onClose={close} width={440} className="about" closeButton>
      <div className="about-hero">
        <img className="about-logo" src={appIcon} alt="" width={68} height={68} />
        <h3>언카라이브</h3>
        <p>아카라이브 스크랩 및 게시글 오프라인 보관 프로그램</p>
        <div className="about-badges">
          <span className="about-badge accent">버전 {state.version}</span>
          <span className="about-badge">{platform} {arch}</span>
          <span className="about-badge">MIT License</span>
        </div>
      </div>
      <div className="about-specs">
        <div className="about-spec">
          <span className="key">업데이트</span>
          <span className="value"><UpdateStatus update={state.update} /></span>
        </div>
        <div className="about-spec">
          <span className="key">오픈소스 구성</span>
          <span className="value about-oss">
            {[['Electron', 'MIT'], ['React', 'MIT'], ['cheerio', 'MIT'], ['Lucide', 'ISC'], ['Pretendard', 'SIL OFL 1.1']].map(([name, license]) => (
              <span key={name} className="about-pill"><b>{name}</b><small>{license}</small></span>
            ))}
          </span>
        </div>
        <div className="about-spec">
          <span className="key">도움말</span>
          <span className="value about-links">
            <a href={`${repository}#readme`} target="_blank" rel="noreferrer">사용 설명서</a>
            <a href={`${repository}/releases`} target="_blank" rel="noreferrer">릴리스 노트</a>
            <a href={`${repository}/issues`} target="_blank" rel="noreferrer">문제 제보</a>
          </span>
        </div>
      </div>
      <p className="about-note">아카라이브 운영사와 무관한 비공식 프로그램입니다.</p>
      <div className="about-foot">
        <span>© 2026 Hishydrogen</span>
        <span className="grow" />
        <button onClick={() => void call('checkForUpdates')} disabled={state.update.checking}>{state.update.checking ? '확인 중…' : '업데이트 확인'}</button>
        <button onClick={() => window.open(repository)}><ExternalLink size={14} />GitHub</button>
      </div>
    </Dialog>
  );
}

/** 새 버전 알림입니다. 오른쪽 아래의 작은 카드로, 보던 화면을 가리지 않고 닫기 전까지 남습니다. */
export function UpdateCard({ update }: { update: UpdateState }) {
  const release = update.notice;
  if (!release) return null;
  return (
    <div className="update-card" role="dialog" aria-label="새 버전 알림">
      <div className="update-head">
        <img src={appIcon} alt="" width={36} height={36} />
        <div className="update-title">
          <b>언카라이브 {release.latest} 버전이 나왔습니다</b>
          <small>현재 사용 중인 버전은 {release.current}입니다</small>
        </div>
        <button className="plain update-close" aria-label="닫기" title="닫기" onClick={() => void call('dismissUpdate', false)}><X size={16} /></button>
      </div>
      {release.notes.length > 0 && (
        <ul className="update-notes">
          {release.notes.map((line, index) => <li key={index} className={line.head ? 'head' : ''}>{line.text}</li>)}
        </ul>
      )}
      {release.page && <div className="update-more"><a href={release.page} target="_blank" rel="noreferrer">릴리스 페이지 보기</a></div>}
      <div className="update-buttons">
        <button className="plain update-skip" onClick={() => void call('dismissUpdate', true)}>이 버전 건너뛰기</button>
        <span className="grow" />
        <button onClick={() => void call('dismissUpdate', false)}>나중에</button>
        <button className="primary" onClick={() => void download()}>다운로드</button>
      </div>
    </div>
  );
}
