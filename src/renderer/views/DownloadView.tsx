import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownCircle, CheckCircle2, CornerDownRight, XCircle } from 'lucide-react';
import { call, formatBytes, formatDuration } from '../api';
import { EmptyState, Header, showToast } from '../components';
import type { AppState, JobState } from '../../shared/types';

const isActive = (job: JobState) => job.status === 'running' || job.status === 'paused' || job.status === 'waitingForChallenge';

export function DownloadView({ state }: { state: AppState }) {
  const job = state.job;
  if (!job) {
    return (
      <div className="screen">
        <Header title="다운로드" />
        <EmptyState
          icon={<ArrowDownCircle size={44} />}
          title="진행 중인 다운로드가 없습니다"
          description="스크랩이나 링크에서 글을 고른 뒤 다운로드를 시작하세요."
          actions={<>
            <button onClick={() => void call('setSection', 'scraps')}>스크랩</button>
            <button onClick={() => void call('setSection', 'collection')}>링크</button>
          </>}
        />
      </div>
    );
  }
  return <JobView state={state} job={job} />;
}

function JobView({ state, job }: { state: AppState; job: JobState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'end' }); }, [job.log.length]);

  const title = {
    running: `${job.finishedPosts} / ${job.totalPosts}개 처리됨` + (job.queuedPosts > 0 ? ` (대기 ${job.queuedPosts}개)` : ''),
    paused: job.activeFiles.length > 0 ? '일시정지하는 중' : '일시정지됨',
    waitingForChallenge: 'Cloudflare 보안 확인 대기 중',
    finished: '다운로드 완료',
    cancelled: '중단됨',
    failed: '다운로드에 실패했습니다',
  }[job.status];
  const detail = {
    running: job.currentTitle,
    paused: job.activeFiles.length > 0
      ? `새 파일은 받지 않고, 받고 있던 파일 ${job.activeFiles.length}개만 끝까지 받은 뒤 멈춥니다. 바로 멈추려면 중단을 누르세요.`
      : '계속을 누르면 멈춘 곳부터 이어서 받습니다.',
    waitingForChallenge: '열린 창에서 보안 확인을 완료하면 다운로드가 자동으로 이어집니다.',
    finished: `저장 위치: ${state.libraryRoot}`,
    cancelled: '다시 시작하면 이미 받은 파일은 건너뛰고 나머지를 이어서 받습니다.',
    failed: job.failure ?? '',
  }[job.status];

  // 멈춰 있던 시간은 빼고, 멈춘 동안에는 그때 값에서 멈춰 둡니다.
  const elapsed = Math.max(0, ((job.finishedAt ?? job.pausedSince ?? now) - job.startedAt - job.pausedMs) / 1000);
  const speed = elapsed > 0 ? job.savedBytes / elapsed : 0;
  let remaining = '-';
  if (job.status === 'paused' || job.status === 'waitingForChallenge') {
    remaining = '멈춤';
  } else if (isActive(job)) {
    remaining = job.finishedPosts > 0 && job.finishedPosts < job.totalPosts
      ? '약 ' + formatDuration((elapsed / job.finishedPosts) * (job.totalPosts - job.finishedPosts))
      : '계산 중';
  }
  const fraction = job.totalPosts > 0 ? job.finishedPosts / job.totalPosts : 0;

  return (
    <div className="screen">
      <Header title="다운로드" />
      <div className="job">
        <div className="job-header">
          <div className="job-title">
            <h2>{title}</h2>
            <p className="muted ellipsis">{detail}</p>
          </div>
          {isActive(job) ? (
            <div className="row">
              <button onClick={() => {
                if (job.status === 'running' && job.activeFiles.length > 0) showToast('받고 있던 파일은 끝까지 받은 뒤 멈춥니다');
                void call('togglePause');
              }} disabled={job.status === 'waitingForChallenge'}>{job.status === 'paused' ? '계속' : '일시정지'}</button>
              <button className="danger" onClick={() => void call('cancelDownload')}>중단</button>
            </div>
          ) : (
            <div className="row">
              <button onClick={() => void call('clearJob')} title="이 다운로드의 기록을 화면에서 지웁니다. 받은 파일은 그대로입니다.">기록 지우기</button>
              <button onClick={() => void call('openLibraryFolder')}>폴더 열기</button>
            </div>
          )}
        </div>
        <progress value={fraction} max={1} />
        <div className="card stats">
          <div className="stat-row">
            <Stat title="저장한 파일" value={`${job.savedFiles}개`} />
            <Stat title="받은 용량" value={formatBytes(job.savedBytes)} />
            <Stat title="실패" value={`글 ${job.failedPosts + job.incompletePosts} · 파일 ${job.failedFiles}`} />
            <Stat title="평균 속도" value={`${formatBytes(Math.round(speed))}/s`} />
            <Stat title="남은 시간" value={remaining} />
          </div>
          {job.activeFiles.length > 0 && (
            <div className="active-files">
              {job.activeFiles.map((file) => (
                <div key={file.id} className="row">
                  {file.expected > 0 ? <progress value={file.received} max={file.expected} /> : <progress />}
                  <span className="caption mono-digits">{formatBytes(file.received)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="log" role="log">
          {job.log.map((line) => (
            <div key={line.id} className={`log-line ${line.level}`}>
              {line.level === 'info' && <CornerDownRight size={14} />}
              {line.level === 'success' && <CheckCircle2 size={14} />}
              {line.level === 'warning' && <AlertTriangle size={14} />}
              {line.level === 'failure' && <XCircle size={14} />}
              <span>{line.text}</span>
            </div>
          ))}
          <div ref={logEnd} />
        </div>
      </div>
    </div>
  );
}

function Stat(props: { title: string; value: string }) {
  return (
    <div className="stat">
      <span className="caption">{props.title}</span>
      <span className="mono-digits">{props.value}</span>
    </div>
  );
}
