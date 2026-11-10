import { call } from '../api';
import { Dialog } from '../components';
import type { AppNotice } from '../../shared/types';

/** 업데이트한 뒤 처음 열었을 때 한 번 보여 주는 안내입니다. 메인 프로세스가 보여 줄 때를 정합니다. */
export function NoticeDialog({ notice }: { notice: AppNotice }) {
  const close = () => void call('dismissNotice');
  return (
    <Dialog title="이제 보관함은 계정마다 나뉩니다" onClose={close} width={520}>
      <div className="terms">
        <p>이번 버전부터 보관함은 항상 로그인한 계정마다 저장 위치 안에 따로 만들어지고, 로그인하지 않았을 때는 <strong>Guest</strong> 보관함을 씁니다. 그래서 설정의 ‘계정마다 보관함 나누기’ 옵션은 없어졌습니다.</p>
        {notice.legacyFolder && (
          <>
            <p>그동안 모든 계정이 함께 쓰던 보관함은 아래 폴더로 옮겼습니다. 받은 글과 파일은 그대로 남아 있지만, 앱의 보관함과 갤러리에는 보이지 않습니다.</p>
            <p className="notice-path">{notice.legacyFolder}</p>
            {notice.incomplete && <p className="warning-text">같은 이름이 이미 있거나 사용 중인 파일이 있어 일부를 옮기지 못했습니다. 다음에 앱을 열 때 다시 옮깁니다.</p>}
          </>
        )}
      </div>
      <div className="dialog-buttons">
        {notice.legacyFolder && <button onClick={() => void call('openLegacyFolder')}>폴더 열기</button>}
        <button className="primary" onClick={close} autoFocus>확인</button>
      </div>
    </Dialog>
  );
}
